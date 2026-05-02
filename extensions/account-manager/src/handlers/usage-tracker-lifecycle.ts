/* eslint max-lines: ["error", { "max": 500, "skipBlankLines": true, "skipComments": true }] */
import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { AccountUsage } from '../bus/schemas.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import type { IUsageProvider, UsageResult } from '../interfaces/usage-provider.js';
import type {
  IAccountCredentialStore,
  IAccountMetadataStore,
  IAccountUsageSnapshotStore,
} from '../interfaces/account-store.js';
import { metadataPatchChanges } from '../utils/json-merge-patch.js';
import { buildUsageAuthClearMetadata, buildUsageAuthInvalidMetadata } from '../utils/usage-auth-state.js';
import { createUsageCacheKey, parseUsageCacheKey } from '../usage/usage-partitioning.js';
import { persistChangedWindows, type PersistedWindowState } from '../usage/usage-persistence.js';
import { collectUsageRefreshTargets } from './usage-refresh-targets.js';

export type InFlightSourcePoll = {
  promise: Promise<void>;
  accountKey: string | null;
};

export const USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS = 30_000;

interface AccountQuiescenceOptions {
  clientId: string;
  key: string;
  inFlightSourcePolls: Map<string, InFlightSourcePoll>;
  inFlightFetches: Map<string, Promise<void>>;
  persistenceChains: Map<string, Promise<void>>;
  timeoutMs?: number;
}

interface TrackerQuiescenceOptions {
  inFlightSourcePolls: Map<string, InFlightSourcePoll>;
  inFlightFetches: Map<string, Promise<void>>;
  persistenceChains: Map<string, Promise<void>>;
  metadataInvalidations: Map<string, Promise<void>>;
  timeoutMs?: number;
}

interface ScheduleUsagePersistenceOptions {
  clientId: string;
  accountId: string;
  usage: AccountUsage;
  generation: number;
  usageSnapshotStore: IAccountUsageSnapshotStore | undefined;
  persistedWindows: Map<string, Map<string, PersistedWindowState>>;
  persistenceChains: Map<string, Promise<void>>;
  isCurrentGeneration: (cacheKey: string, generation: number) => boolean;
  isStopped: () => boolean;
  onPersistenceError: (clientId: string, error: unknown) => void;
}

interface ApplyMetadataPatchesOptions {
  bus: IMakaioBus;
  clientId: string;
  accountId: string;
  generation: number;
  metadataStore: IAccountMetadataStore;
  patches: Record<string, unknown> | undefined;
  isAccountGone: (key: string, generation: number) => boolean;
}

interface ApplyFreshUsageOptions extends ApplyMetadataPatchesOptions, Omit<ScheduleUsagePersistenceOptions, 'usage'> {
  bus: IMakaioBus;
  key: string;
  accountMetadata: Record<string, unknown>;
  result: UsageResult;
  usageCache: Map<string, AccountUsage>;
  onMetadataPatchError: (clientId: string, error: unknown) => void;
}

interface ApplyResolvedUsageOptions extends ApplyFreshUsageOptions {
  errorCooldownUntil: Map<string, number>;
}

interface ScheduleMetadataInvalidationOptions {
  clientId: string;
  accountId: string;
  metadataStore: IAccountMetadataStore;
  metadataInvalidations: Map<string, Promise<void>>;
  onInvalidationError: (clientId: string, error: unknown) => void;
}

interface ScheduleTrackedMetadataInvalidationsOptions extends Omit<
  ScheduleMetadataInvalidationOptions,
  'clientId' | 'accountId'
> {
  trackedKeys: Iterable<string>;
}

interface InvalidateTrackerAccountStateOptions extends ScheduleMetadataInvalidationOptions {
  accountGenerations: Map<string, number>;
  usageCache: Map<string, AccountUsage>;
  persistedWindows: Map<string, Map<string, PersistedWindowState>>;
  lastFetchAt: Map<string, number>;
  errorCooldownUntil: Map<string, number>;
  /** Pending-reset deduplication map; outer key is cache key, inner key is windowId. */
  pendingResets: Map<string, Map<string, number>>;
  /** Reverse lookup from cache key to client/account identifiers. */
  cacheKeyIndex: Map<string, { clientId: string; accountId: string }>;
}

interface EmitStaleSnapshotOptions {
  bus: IMakaioBus;
  clientId: string;
  accountId: string;
  key: string;
  generation: number;
  usageCache: Map<string, AccountUsage>;
  isAccountGone: (key: string, generation: number) => boolean;
}

interface PersistUsageAuthInvalidOptions {
  bus: IMakaioBus;
  clientId: string;
  accountId: string;
  metadataStore: IAccountMetadataStore;
  key: string;
  generation: number;
  reason: string;
  fingerprint: string;
  usageCache: Map<string, AccountUsage>;
  errorCooldownUntil: Map<string, number>;
  isAccountGone: (key: string, generation: number) => boolean;
}

interface ResolveUsageSafelyOptions {
  source: IUsageProvider;
  credential: Parameters<IUsageProvider['resolveUsage']>[0];
  clientId: string;
  onResolveError: (clientId: string, error: unknown) => void;
}

interface IsFetchSuppressedOptions {
  key: string;
  forceRefresh: boolean | undefined;
  throttleMs: number;
  lastFetchAt: Map<string, number>;
  errorCooldownUntil: Map<string, number>;
}

interface StartUsageRefreshesOptions {
  sources: Map<string, IUsageProvider>;
  metadataStore: IAccountMetadataStore;
  credentialStore: IAccountCredentialStore;
  clientId?: string;
  accountId?: string;
  startFetch: (clientId: string, accountId: string) => boolean;
}

/**
 * Waits for already-started work that still belongs to one account to drain.
 * @param opts - Account-scoped quiescence state
 * @returns Nothing
 */
export async function awaitAccountQuiescence(opts: AccountQuiescenceOptions): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS);
  while (true) {
    const poll = opts.inFlightSourcePolls.get(opts.clientId);
    const pending = [
      poll && (poll.accountKey === null || poll.accountKey === opts.key) ? poll.promise : undefined,
      opts.inFlightFetches.get(opts.key),
      opts.persistenceChains.get(opts.key),
    ].filter((promise): promise is Promise<void> => promise !== undefined);
    if (pending.length === 0) return true;
    if (!(await settlePendingBeforeDeadline(pending, deadline))) return false;
  }
}

/**
 * Waits for all already-started tracker work to drain.
 * @param opts - Whole-tracker quiescence state
 * @returns Nothing
 */
export async function awaitTrackerQuiescence(opts: TrackerQuiescenceOptions): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? USAGE_TRACKER_QUIESCENCE_TIMEOUT_MS);
  while (true) {
    const pending = [
      ...opts.inFlightSourcePolls.values().map((poll) => poll.promise),
      ...opts.inFlightFetches.values(),
      ...opts.persistenceChains.values(),
      ...opts.metadataInvalidations.values(),
    ];
    if (pending.length === 0) return true;
    if (!(await settlePendingBeforeDeadline(pending, deadline))) return false;
  }
}

/**
 * Chains usage-window persistence for one account behind any prior write.
 * @param opts - Persistence dependencies and current usage snapshot
 * @returns Nothing
 */
export function scheduleUsagePersistence(opts: ScheduleUsagePersistenceOptions): void {
  if (!opts.usageSnapshotStore) return;

  const key = createUsageCacheKey(opts.clientId, opts.accountId);
  const previous = opts.persistenceChains.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        await runPersistence({
          ...opts,
          cacheKey: key,
        });
      } catch (error) {
        opts.onPersistenceError(opts.clientId, error);
      }
    });

  opts.persistenceChains.set(key, next);
  void next.finally(() => {
    if (opts.persistenceChains.get(key) === next) opts.persistenceChains.delete(key);
  });
}

/**
 * Records one durable metadata-generation invalidation for an account.
 * @param opts - Invalidation dependencies and error hook
 * @returns Promise that settles when the durable bump attempt has finished
 */
export function scheduleMetadataInvalidation(opts: ScheduleMetadataInvalidationOptions): Promise<void> {
  const key = createUsageCacheKey(opts.clientId, opts.accountId);
  const invalidation = opts.metadataStore
    .bumpMetadataGeneration(opts.clientId, opts.accountId)
    .then(() => undefined)
    .catch((error: unknown) => {
      opts.onInvalidationError(opts.clientId, error);
    });
  opts.metadataInvalidations.set(key, invalidation);
  return invalidation.finally(() => {
    if (opts.metadataInvalidations.get(key) === invalidation) {
      opts.metadataInvalidations.delete(key);
    }
  });
}

/**
 * Starts durable metadata-generation invalidations for a set of tracked accounts.
 * @param opts - Tracked cache keys plus invalidation dependencies
 * @returns Nothing
 */
export function scheduleTrackedMetadataInvalidations(opts: ScheduleTrackedMetadataInvalidationsOptions): void {
  for (const key of opts.trackedKeys) {
    const { clientId, accountId } = parseUsageCacheKey(key);
    void scheduleMetadataInvalidation({
      clientId,
      accountId,
      metadataStore: opts.metadataStore,
      metadataInvalidations: opts.metadataInvalidations,
      onInvalidationError: opts.onInvalidationError,
    });
  }
}

/**
 * Invalidates local tracker state and bumps the durable metadata generation.
 * @param opts - Tracker state plus durable invalidation dependencies
 * @returns Promise that settles when the durable bump attempt has finished
 */
export function invalidateTrackerAccountState(opts: InvalidateTrackerAccountStateOptions): Promise<void> {
  const key = createUsageCacheKey(opts.clientId, opts.accountId);
  opts.accountGenerations.set(key, (opts.accountGenerations.get(key) ?? 0) + 1);
  opts.usageCache.delete(key);
  opts.persistedWindows.delete(key);
  opts.lastFetchAt.delete(key);
  opts.errorCooldownUntil.delete(key);
  opts.pendingResets.delete(key);
  opts.cacheKeyIndex.delete(key);
  return scheduleMetadataInvalidation(opts);
}

/**
 * Re-emits the cached usage snapshot (or an empty placeholder) as stale while
 * ownership still holds.
 *
 * When no prior cached snapshot exists, emits an empty stale snapshot so
 * consumers (e.g. the TUI's pending-resolution tracker) receive a
 * `usage.updated` event and can clear any "awaiting resolution" state.
 * @param opts - Stale snapshot emission dependencies
 * @returns Nothing
 */
export async function emitStaleSnapshotIfCurrent(opts: EmitStaleSnapshotOptions): Promise<void> {
  if (opts.isAccountGone(opts.key, opts.generation)) return;
  const previous = opts.usageCache.get(opts.key);
  const now = Date.now();
  const staleSnapshot: AccountUsage = previous
    ? { ...previous, fetchedAt: now, stale: true, lastOkAt: previous.lastOkAt ?? previous.fetchedAt }
    : { fetchedAt: now, windows: [], stale: true };
  if (previous) {
    opts.usageCache.set(opts.key, staleSnapshot);
  }
  if (opts.isAccountGone(opts.key, opts.generation)) {
    opts.usageCache.delete(opts.key);
    return;
  }
  await opts.bus.emit(AccountManagerSubjects.usage.updated, {
    clientId: opts.clientId,
    accountId: opts.accountId,
    usage: staleSnapshot,
  });
}

/**
 * Applies metadata corrections only while the fetch still owns the account generation.
 * @param opts - Metadata patch dependencies and ownership guard
 * @returns Nothing
 */
export async function applyMetadataPatchesIfCurrent(opts: ApplyMetadataPatchesOptions): Promise<void> {
  if (!opts.patches) return;

  const key = createUsageCacheKey(opts.clientId, opts.accountId);
  if (opts.isAccountGone(key, opts.generation)) return;

  const latest = await opts.metadataStore.getWithMetadataGeneration(opts.clientId, opts.accountId);
  if (opts.isAccountGone(key, opts.generation) || !latest) return;

  const changed = metadataPatchChanges(latest.account.metadata, opts.patches);
  if (!changed) return;

  if (opts.isAccountGone(key, opts.generation)) return;
  const updated = await opts.metadataStore.patchMetadata(
    opts.clientId,
    opts.accountId,
    latest.metadataGeneration,
    opts.patches,
  );
  if (!updated || opts.isAccountGone(key, opts.generation)) return;
  await opts.bus.emit(AccountManagerSubjects.accounts.metadataPatched, {
    clientId: opts.clientId,
    account: updated,
  });
}

interface CheckAndEmitPendingResetsOptions {
  bus: IMakaioBus;
  clientId: string;
  accountId: string;
  key: string;
  generation: number;
  freshSnapshot: AccountUsage;
  pendingResets: Map<string, Map<string, number>>;
  isAccountGone: (key: string, generation: number) => boolean;
}

/**
 * Detects usage-window expiry state transitions and emits
 * `usage.windowResetAvailable` once per unique expired window instance.
 *
 * Each window in `freshSnapshot` is compared to the `pendingResets` map:
 * - If `resetsAt < Date.now()` and the window is untracked or has a different
 *   `expiredAt` → the window has newly entered the reset-available state: add
 *   it to `pendingResets` and emit the event.
 * - If `resetsAt < Date.now()` and already tracked with the same `expiredAt`
 *   → no-op (event already emitted for this expiry).
 * - If `resetsAt >= Date.now()` and currently tracked → the window was
 *   activated (new future window arrived): remove the entry so that the next
 *   expiry can fire a fresh event.
 * - If a previously tracked window is absent from `freshSnapshot` → remove the
 *   entry so provider window catalog changes cannot pin stale dedupe state.
 * @param opts - Pending-reset emission dependencies
 * @returns Nothing
 */
export async function checkAndEmitPendingResets(opts: CheckAndEmitPendingResetsOptions): Promise<void> {
  const now = Date.now();
  const seenWindowIds = new Set<string>();
  let windowMap = opts.pendingResets.get(opts.key);

  for (const window of opts.freshSnapshot.windows) {
    if (opts.isAccountGone(opts.key, opts.generation)) return;
    seenWindowIds.add(window.id);

    if (window.resetsAt < now) {
      const storedExpiredAt = windowMap?.get(window.id);
      if (storedExpiredAt !== window.resetsAt) {
        // New window instance — record and emit.
        if (!windowMap) {
          windowMap = new Map<string, number>();
          opts.pendingResets.set(opts.key, windowMap);
        }
        windowMap.set(window.id, window.resetsAt);
        await opts.bus.emit(AccountManagerSubjects.usage.windowResetAvailable, {
          clientId: opts.clientId,
          accountId: opts.accountId,
          windowId: window.id,
          expiredAt: window.resetsAt,
        });
      }
      // If storedExpiredAt matches: already emitted, no-op.
    } else {
      // Window has a future resetsAt — remove any stale pending entry.
      if (windowMap?.has(window.id)) {
        windowMap.delete(window.id);
        if (windowMap.size === 0) opts.pendingResets.delete(opts.key);
      }
    }
  }

  if (windowMap) {
    for (const windowId of windowMap.keys()) {
      if (!seenWindowIds.has(windowId)) {
        windowMap.delete(windowId);
      }
    }
    if (windowMap.size === 0) opts.pendingResets.delete(opts.key);
  }
}

/**
 * Publishes fresh usage, applies metadata patches, and queues window persistence.
 * @param opts - Fresh-usage side effects plus ownership guards
 * @returns Nothing
 */
export async function applyFreshUsage(opts: ApplyFreshUsageOptions): Promise<void> {
  const usageAuthClearPatches = buildUsageAuthClearMetadata(opts.accountMetadata);
  const metadataPatches =
    usageAuthClearPatches === null
      ? opts.result.metadataPatches
      : { ...usageAuthClearPatches, ...(opts.result.metadataPatches ?? {}) };
  const fresh: AccountUsage = { ...opts.result.usage, stale: false, lastOkAt: opts.result.usage.fetchedAt };
  opts.usageCache.set(opts.key, fresh);
  if (opts.isAccountGone(opts.key, opts.generation)) {
    opts.usageCache.delete(opts.key);
    return;
  }
  await opts.bus.emit(AccountManagerSubjects.usage.updated, {
    clientId: opts.clientId,
    accountId: opts.accountId,
    usage: fresh,
  });
  if (opts.isAccountGone(opts.key, opts.generation)) return;
  try {
    await applyMetadataPatchesIfCurrent({ ...opts, patches: metadataPatches });
  } catch (error) {
    opts.onMetadataPatchError(opts.clientId, error);
  }
  if (opts.isAccountGone(opts.key, opts.generation)) return;
  scheduleUsagePersistence({
    clientId: opts.clientId,
    accountId: opts.accountId,
    usage: fresh,
    generation: opts.generation,
    usageSnapshotStore: opts.usageSnapshotStore,
    persistedWindows: opts.persistedWindows,
    persistenceChains: opts.persistenceChains,
    isCurrentGeneration: opts.isCurrentGeneration,
    isStopped: opts.isStopped,
    onPersistenceError: opts.onPersistenceError,
  });
}

/**
 * Clears transient error cooldown and publishes a successful usage fetch.
 * @param opts - Fresh-usage side effects plus the cooldown map to clear
 * @returns Nothing
 */
export async function applyResolvedUsage(opts: ApplyResolvedUsageOptions): Promise<void> {
  opts.errorCooldownUntil.delete(opts.key);
  await applyFreshUsage(opts);
}

/**
 * Persists an auth-invalid marker for the credential that just failed usage auth.
 * @param opts - Account metadata patch dependencies plus the failing fingerprint
 * @returns Nothing
 */
export async function persistUsageAuthInvalidIfCurrent(opts: PersistUsageAuthInvalidOptions): Promise<void> {
  const latest = await opts.metadataStore.getWithMetadataGeneration(opts.clientId, opts.accountId);
  if (!latest || opts.isAccountGone(opts.key, opts.generation)) return;
  const patches = buildUsageAuthInvalidMetadata(opts.fingerprint, opts.reason, Date.now());
  const updated = await opts.metadataStore.patchMetadata(
    opts.clientId,
    opts.accountId,
    latest.metadataGeneration,
    patches,
  );
  if (updated && !opts.isAccountGone(opts.key, opts.generation)) {
    await opts.bus.emit(AccountManagerSubjects.accounts.metadataPatched, {
      clientId: opts.clientId,
      account: updated,
    });
  }
  opts.usageCache.delete(opts.key);
  opts.errorCooldownUntil.delete(opts.key);
}

/**
 * Resolves usage while normalizing non-rate-limit failures to `null`.
 * @param opts - Usage-provider call dependencies and error hook
 * @returns Usage result, or `null` on transient failure
 * @throws RateLimitedError when the upstream API returns HTTP 429
 * @throws UsageAuthInvalidError when the upstream API definitively rejects the credential
 */
export async function resolveUsageSafely(opts: ResolveUsageSafelyOptions): Promise<UsageResult | null> {
  try {
    return await opts.source.resolveUsage(opts.credential);
  } catch (error) {
    if (error instanceof RateLimitedError || error instanceof UsageAuthInvalidError) throw error;
    opts.onResolveError(opts.clientId, error);
    return null;
  }
}

/**
 * Returns whether throttle or cooldown should suppress a fetch.
 * @param opts - Fetch timing state for one account
 * @returns Whether the fetch should be skipped
 */
export function isFetchSuppressed(opts: IsFetchSuppressedOptions): boolean {
  const now = Date.now();
  return (
    (!opts.forceRefresh && now - (opts.lastFetchAt.get(opts.key) ?? 0) < opts.throttleMs) ||
    now < (opts.errorCooldownUntil.get(opts.key) ?? 0)
  );
}

/**
 * Resolves refresh targets and starts the fetches that can claim new work.
 * @param opts - Refresh-target resolution dependencies
 * @returns Number of fetches that actually started
 */
export async function startUsageRefreshes(opts: StartUsageRefreshesOptions): Promise<number> {
  const targets = await collectUsageRefreshTargets(
    opts.sources,
    opts.metadataStore,
    opts.credentialStore,
    opts.clientId,
    opts.accountId,
  );
  let started = 0;
  for (const target of targets) {
    if (opts.startFetch(target.clientId, target.accountId)) started += 1;
  }
  return started;
}

/**
 * Waits for pending work to settle, but only until the deadline expires.
 * @param pending - Pending work owned by the current quiescence scope
 * @param deadline - Epoch-millisecond deadline for the wait
 * @returns `true` when all pending work settled before the deadline
 */
async function settlePendingBeforeDeadline(pending: Promise<void>[], deadline: number): Promise<boolean> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;
  return Promise.race([
    Promise.allSettled(pending).then(() => true),
    new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), remainingMs);
      timeout.unref();
    }),
  ]);
}

/**
 * Collects all usage windows currently in the reset-available state from the
 * live usage cache, optionally filtered by source and account.
 *
 * Results are computed live on every call so they always reflect the current
 * cache state, even if `pendingResets` event deduplication has drifted.
 * @param usageCache - Live usage cache to scan
 * @param cacheKeyIndex - Reverse lookup from usage cache key to account coordinates
 * @param clientId - Optional source filter; `undefined` matches all sources
 * @param accountId - Optional account filter; requires `clientId`
 * @returns Pending-reset entries for all windows where `resetsAt < Date.now()`
 */
export function collectPendingResetsFromCache(
  usageCache: Map<string, AccountUsage>,
  cacheKeyIndex: ReadonlyMap<string, { clientId: string; accountId: string }>,
  clientId: string | undefined,
  accountId: string | undefined,
): Array<{ clientId: string; accountId: string; windowId: string; expiredAt: number }> {
  if (accountId !== undefined && clientId === undefined) {
    throw new Error('accountId requires clientId');
  }
  const now = Date.now();
  const results: Array<{ clientId: string; accountId: string; windowId: string; expiredAt: number }> = [];
  for (const [key, identity] of cacheKeyIndex) {
    const usage = usageCache.get(key);
    if (!usage) continue;
    if (clientId !== undefined && identity.clientId !== clientId) continue;
    if (accountId !== undefined && identity.accountId !== accountId) continue;
    for (const window of usage.windows) {
      if (window.resetsAt < now) {
        results.push({
          clientId: identity.clientId,
          accountId: identity.accountId,
          windowId: window.id,
          expiredAt: window.resetsAt,
        });
      }
    }
  }
  return results;
}

interface RunPersistenceOptions extends ScheduleUsagePersistenceOptions {
  cacheKey: string;
}

/**
 * Persists changed usage windows unless stop or generation invalidation has won.
 * @param opts - Persistence dependencies plus the resolved cache key
 */
async function runPersistence(opts: RunPersistenceOptions): Promise<void> {
  if (!opts.usageSnapshotStore) return;
  const previous = opts.persistedWindows.get(opts.cacheKey) ?? new Map<string, PersistedWindowState>();
  const result = await persistChangedWindows(
    {
      append: (entry) => opts.usageSnapshotStore!.append(opts.clientId, opts.accountId, entry),
    },
    opts.usage,
    previous,
    () => opts.isStopped() || !opts.isCurrentGeneration(opts.cacheKey, opts.generation),
  );
  if (result && !opts.isStopped() && opts.isCurrentGeneration(opts.cacheKey, opts.generation)) {
    opts.persistedWindows.set(opts.cacheKey, result);
  }
}
