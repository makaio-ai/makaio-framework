import type { IMakaioBus } from '@makaio/bus-core';
import type { AccountUsage } from '../bus/schemas.js';
import type { IUsageProvider } from '../interfaces/usage-provider.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import type {
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
  StoredAccount,
} from '../interfaces/account-store.js';
import { getStoredAccount } from '../storage/joined-account-store.js';
import { logAccountManagerDiagnostic } from '../utils/diagnostics.js';
import { isUsageAuthInvalidForFingerprint } from '../utils/usage-auth-state.js';
import type { PersistedWindowState } from '../usage/usage-persistence.js';
import { readUsageCredential } from './read-usage-credential.js';
import { applyResolvedUsage, persistUsageAuthInvalidIfCurrent, resolveUsageSafely } from './usage-tracker-lifecycle.js';
import type { UsagePreparedCredential } from './usage-tracker-types.js';

interface LoadUsageFetchAccountOptions {
  metadataStore: IAccountMetadataStore;
  credentialStore: IAccountCredentialStore;
  clientId: string;
  accountId: string;
  key: string;
  generation: number;
  isAccountGone: (key: string, generation: number) => boolean;
  invalidateAccountState: (clientId: string, accountId: string) => Promise<void>;
}

interface ResolveUsageFetchCredentialOptions {
  readCredential: ((clientId: string, accountId: string) => Promise<UsagePreparedCredential | null>) | undefined;
  clientId: string;
  accountId: string;
  key: string;
  account: StoredAccount;
}

/** Consecutive transient failures before escalating to reauth-required. */
export const MAX_TRANSIENT_FAILURES = 3;

interface ApplyUsageFetchResultOptions {
  bus: IMakaioBus;
  accountMetadata: Record<string, unknown>;
  clientId: string;
  accountId: string;
  key: string;
  generation: number;
  metadataStore: IAccountMetadataStore;
  result: { usage: AccountUsage; metadataPatches?: Record<string, unknown> } | null;
  usageCache: Map<string, AccountUsage>;
  usageSnapshotStore: IAccountUsageSnapshotStore | undefined;
  persistedWindows: Map<string, Map<string, PersistedWindowState>>;
  persistenceChains: Map<string, Promise<void>>;
  errorCooldownUntil: Map<string, number>;
  errorCooldownMs: number;
  transientFailureCounts: Map<string, number>;
  fingerprint: string;
  isAccountGone: (key: string, generation: number) => boolean;
  isCurrentGeneration: (key: string, generation: number) => boolean;
  isStopped: () => boolean;
  emitStaleSnapshot: (clientId: string, accountId: string, key: string, generation: number) => Promise<void>;
  onMetadataPatchError: (clientId: string, error: unknown) => void;
  onPersistenceError: (clientId: string, error: unknown) => void;
}

interface EscalateTransientFailureOptions {
  bus: IMakaioBus;
  clientId: string;
  accountId: string;
  key: string;
  generation: number;
  fingerprint: string;
  metadataStore: IAccountMetadataStore;
  usageCache: Map<string, AccountUsage>;
  errorCooldownUntil: Map<string, number>;
  errorCooldownMs: number;
  transientFailureCounts: Map<string, number>;
  isAccountGone: (key: string, generation: number) => boolean;
  emitStaleSnapshot: (clientId: string, accountId: string, key: string, generation: number) => Promise<void>;
}

interface HandleUsageFetchErrorOptions {
  bus: IMakaioBus;
  clientId: string;
  accountId: string;
  key: string;
  generation: number;
  credential: RawCredential | null;
  error: unknown;
  metadataStore: IAccountMetadataStore;
  usageCache: Map<string, AccountUsage>;
  errorCooldownUntil: Map<string, number>;
  sourceCooldownUntil: Map<string, number>;
  transientFailureCounts: Map<string, number>;
  defaultErrorCooldownMs: number;
  isAccountGone: (key: string, generation: number) => boolean;
  emitStaleSnapshot: (clientId: string, accountId: string, key: string, generation: number) => Promise<void>;
  onUnexpectedError: (clientId: string, error: unknown) => void;
}

interface ExecuteUsageFetchOptions extends Omit<ApplyUsageFetchResultOptions, 'result'> {
  source: IUsageProvider;
  account: StoredAccount;
  preparedCredential: UsagePreparedCredential;
  onResolveError: (clientId: string, error: unknown) => void;
}

/**
 * Builds a stable request-scoped prefix for usage tracker logs.
 * @param clientId - Source/client identifier
 * @param accountId - Account identifier within the source
 * @returns Prefix including timestamp, source, account, and request kind
 */
function buildUsageFetchLogPrefix(clientId: string, accountId: string): string {
  return `[UsageTracker] ${new Date().toISOString()} source ${clientId} account ${accountId} resolveUsage`;
}

/**
 * Loads the current joined account row for a fetch, invalidating local state if it disappeared.
 * @param opts - Joined-store dependencies plus current ownership generation
 * @returns Joined account row, or null when missing/stale
 */
export async function loadUsageFetchAccount(opts: LoadUsageFetchAccountOptions): Promise<StoredAccount | null> {
  const account = await getStoredAccount(opts.metadataStore, opts.credentialStore, opts.clientId, opts.accountId);
  if (opts.isAccountGone(opts.key, opts.generation)) return null;
  if (account) return account;
  await opts.invalidateAccountState(opts.clientId, opts.accountId);
  return null;
}

/**
 * Resolves the credential that should back a usage fetch for the current account row.
 * @param opts - Account-manager credential preparation seam plus stored account row
 * @returns Prepared credential outcome for the current fetch
 */
export async function resolveUsageFetchCredential(
  opts: ResolveUsageFetchCredentialOptions,
): Promise<UsagePreparedCredential> {
  return readUsageCredential(opts.readCredential, opts.clientId, opts.accountId, opts.key, opts.account.credential);
}

/**
 * Applies either a successful usage fetch or the transient-stale fallback.
 *
 * Counter mutations on `transientFailureCounts` are intentionally not gated
 * by `isCurrentGeneration` — counter increments from stale generations are
 * harmless because {@link persistUsageAuthInvalidIfCurrent} has its own
 * generation guard, and the next current-generation success or credential
 * change clears the counter.
 * @param opts - Result-handling dependencies for the current fetch ownership generation
 * @returns Nothing
 */
export async function applyUsageFetchResult(opts: ApplyUsageFetchResultOptions): Promise<void> {
  if (opts.result) {
    opts.transientFailureCounts.delete(opts.key);
    await applyResolvedUsage({
      bus: opts.bus,
      accountMetadata: opts.accountMetadata,
      clientId: opts.clientId,
      accountId: opts.accountId,
      key: opts.key,
      generation: opts.generation,
      metadataStore: opts.metadataStore,
      patches: opts.result.metadataPatches,
      result: opts.result,
      usageCache: opts.usageCache,
      usageSnapshotStore: opts.usageSnapshotStore,
      persistedWindows: opts.persistedWindows,
      persistenceChains: opts.persistenceChains,
      errorCooldownUntil: opts.errorCooldownUntil,
      isAccountGone: opts.isAccountGone,
      isCurrentGeneration: opts.isCurrentGeneration,
      isStopped: opts.isStopped,
      onMetadataPatchError: opts.onMetadataPatchError,
      onPersistenceError: opts.onPersistenceError,
    });
    console.info(
      `${buildUsageFetchLogPrefix(opts.clientId, opts.accountId)} succeeded (windows=${opts.result.usage.windows.length})`,
    );
    return;
  }

  await escalateOrCooldownTransientFailure(opts);
}

/**
 * Increments the transient failure counter for an account and either escalates
 * to `reauth-required` (after {@link MAX_TRANSIENT_FAILURES} consecutive nulls)
 * or applies an error cooldown and emits a stale snapshot.
 *
 * The counter resets on success (in {@link applyUsageFetchResult}), on account
 * invalidation (in `UsageTracker.invalidateAccountState`), on credential change
 * (in {@link executeUsageFetch} when `preparedCredential.changed`), on
 * auth-invalid or invalid-credential paths, and on `RateLimitedError`.
 * @param opts - Escalation dependencies for the current fetch ownership generation
 */
async function escalateOrCooldownTransientFailure(opts: EscalateTransientFailureOptions): Promise<void> {
  const failCount = (opts.transientFailureCounts.get(opts.key) ?? 0) + 1;
  opts.transientFailureCounts.set(opts.key, failCount);

  if (failCount >= MAX_TRANSIENT_FAILURES) {
    console.warn(
      `${buildUsageFetchLogPrefix(opts.clientId, opts.accountId)} ${failCount} consecutive transient failures, escalating to reauth-required`,
    );
    await persistUsageAuthInvalidIfCurrent({
      bus: opts.bus,
      clientId: opts.clientId,
      accountId: opts.accountId,
      key: opts.key,
      generation: opts.generation,
      reason: `${failCount} consecutive transient usage-fetch failures`,
      fingerprint: opts.fingerprint,
      metadataStore: opts.metadataStore,
      usageCache: opts.usageCache,
      errorCooldownUntil: opts.errorCooldownUntil,
      isAccountGone: opts.isAccountGone,
    });
    opts.transientFailureCounts.delete(opts.key);
    return;
  }

  opts.errorCooldownUntil.set(opts.key, Date.now() + opts.errorCooldownMs);
  console.warn(
    `${buildUsageFetchLogPrefix(opts.clientId, opts.accountId)} transient failure ${failCount}/${MAX_TRANSIENT_FAILURES}, errorCooldown ${opts.errorCooldownMs}ms`,
  );
  await opts.emitStaleSnapshot(opts.clientId, opts.accountId, opts.key, opts.generation);
}

/**
 * Resolves usage for one loaded account row and applies the result while ownership still holds.
 * @param opts - Loaded-account fetch dependencies plus result-handling hooks
 * @returns The credential that backed the fetch attempt
 */
export async function executeUsageFetch(opts: ExecuteUsageFetchOptions): Promise<RawCredential> {
  console.info(
    `${buildUsageFetchLogPrefix(opts.clientId, opts.accountId)} preparedCredential status=${opts.preparedCredential.status}${opts.preparedCredential.status === 'ready' ? `, changed=${opts.preparedCredential.changed}` : ''}`,
  );
  if (opts.preparedCredential.status === 'invalid') {
    opts.transientFailureCounts.delete(opts.key);
    await persistUsageAuthInvalidIfCurrent({
      bus: opts.bus,
      clientId: opts.clientId,
      accountId: opts.accountId,
      key: opts.key,
      generation: opts.generation,
      reason: opts.preparedCredential.reason,
      fingerprint: opts.preparedCredential.credential.fingerprint,
      metadataStore: opts.metadataStore,
      usageCache: opts.usageCache,
      errorCooldownUntil: opts.errorCooldownUntil,
      isAccountGone: opts.isAccountGone,
    });
    return opts.preparedCredential.credential;
  }

  const credential = opts.preparedCredential.credential;
  if (opts.preparedCredential.changed) {
    opts.transientFailureCounts.delete(opts.key);
  }
  logAccountManagerDiagnostic(
    'UsageTracker',
    `resolveUsage ${opts.clientId}/${opts.accountId} (${opts.account.active ? 'active' : 'inactive'})`,
  );
  if (
    !opts.preparedCredential.changed &&
    isUsageAuthInvalidForFingerprint(opts.account.metadata, credential.fingerprint)
  ) {
    return credential;
  }
  const result = await resolveUsageSafely({
    source: opts.source,
    credential,
    clientId: opts.clientId,
    onResolveError: opts.onResolveError,
  });
  if (opts.isAccountGone(opts.key, opts.generation)) return credential;
  await applyUsageFetchResult({ ...opts, result });
  return credential;
}

/**
 * Applies the tracker's auth-invalid / rate-limit / unexpected-error policy for one failed fetch.
 * @param opts - Error-handling dependencies for the current fetch ownership generation
 * @returns Nothing
 */
export async function handleUsageFetchError(opts: HandleUsageFetchErrorOptions): Promise<void> {
  if (opts.error instanceof UsageAuthInvalidError) {
    if (opts.isAccountGone(opts.key, opts.generation) || opts.credential === null) return;
    opts.transientFailureCounts.delete(opts.key);
    await persistUsageAuthInvalidIfCurrent({
      bus: opts.bus,
      clientId: opts.clientId,
      accountId: opts.accountId,
      key: opts.key,
      generation: opts.generation,
      reason: opts.error.reason,
      fingerprint: opts.credential.fingerprint,
      metadataStore: opts.metadataStore,
      usageCache: opts.usageCache,
      errorCooldownUntil: opts.errorCooldownUntil,
      isAccountGone: opts.isAccountGone,
    });
    return;
  }
  if (opts.error instanceof RateLimitedError) {
    opts.transientFailureCounts.delete(opts.key);
    const cooldown = Math.max(opts.error.retryAfterMs, opts.defaultErrorCooldownMs);
    opts.sourceCooldownUntil.set(opts.clientId, Date.now() + cooldown);
    if (opts.isAccountGone(opts.key, opts.generation)) return;
    opts.errorCooldownUntil.set(opts.key, Date.now() + cooldown);
    console.warn(`${buildUsageFetchLogPrefix(opts.clientId, opts.accountId)} rate-limited, cooldown ${cooldown}ms`);
    await opts.emitStaleSnapshot(opts.clientId, opts.accountId, opts.key, opts.generation);
    return;
  }
  if (opts.isAccountGone(opts.key, opts.generation)) return;
  opts.onUnexpectedError(opts.clientId, opts.error);
}
