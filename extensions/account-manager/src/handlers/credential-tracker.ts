import { randomUUID } from 'node:crypto';
import type { IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import type {
  AccountTimelineReason,
  IAccountCredentialStore,
  IAccountMetadataStore,
  StoredAccount,
} from '../interfaces/account-store.js';
import type { Account } from '../bus/schemas.js';
import { toPublicAccount } from '../utils/to-public-account.js';
import { emitCredentialChangedForClient } from '../credential-lifecycle.js';
import { listStoredAccounts, removeStoredAccount, upsertStoredAccount } from '../storage/joined-account-store.js';
import {
  appendActivationTimelineBestEffort,
  commitActivatedAccountState,
  rollbackActivatedAccountState,
} from '../storage/activation-state.js';
import { canonicalizeBootstrapAccounts } from '../bootstrap-account-canonicalization.js';
import { jsonValuesEqual } from '../utils/json-merge-patch.js';
import {
  mergeSourceAccountMetadata,
  mergeSourceAccountMetadataWithIdentityCheck,
} from '../utils/source-account-metadata.js';
import { findAccountByCredentialKey } from '../utils/credential-key-dedup.js';
import type { CredentialSourceWithOptionalLabel, CredentialTrackerDeps } from './credential-tracker-types.js';

/** Default polling interval in milliseconds. */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

export type { CredentialSourceWithOptionalLabel, CredentialTrackerDeps };

/**
 * Owns `credentials.*` subjects.
 *
 * Polls each {@link ICredentialSource} on a fixed interval, detects new
 * accounts, known-account switches, and token refreshes, and emits the
 * appropriate bus events. Credential fanout runs outside the mutation lock
 * to prevent deadlock.
 */
export class CredentialTracker {
  private readonly bus: IMakaioBus;
  private readonly sources: CredentialSourceWithOptionalLabel[];
  private readonly credentialStore: IAccountCredentialStore;
  private readonly metadataStore: IAccountMetadataStore;
  private readonly withClientMutation: CredentialTrackerDeps['withClientMutation'];
  private readonly pollIntervalMs: number;

  /** Tracks the last-seen fingerprint per clientId to detect changes. */
  private readonly _lastSeen = new Map<string, string>();

  /** Guards against overlapping poll invocations when a poll exceeds the interval. */
  private polling = false;

  private handle: ReturnType<typeof setInterval> | undefined;

  /**
   * @param deps - Injected dependencies
   */
  public constructor(deps: CredentialTrackerDeps) {
    this.bus = deps.bus;
    this.sources = deps.sources;
    this.credentialStore = deps.credentialStore;
    this.metadataStore = deps.metadataStore;
    this.withClientMutation = deps.withClientMutation;
    this.pollIntervalMs = deps.pollIntervalMs;
  }

  /**
   * Runs the initial poll synchronously then starts the polling interval.
   * @returns Promise that resolves after the first poll completes
   */
  public async start(): Promise<void> {
    await this.bootstrapDedup();
    await this.poll();
    this.handle = setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      void this.poll().finally(() => (this.polling = false));
    }, this.pollIntervalMs);
  }

  /**
   * Stops the polling interval.
   */
  public stop(): void {
    if (this.handle !== undefined) {
      clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  /**
   * Returns the last-seen fingerprint for a client, or undefined if not tracked.
   *
   * The map tracks fingerprints (the dedup key from {@link RawCredential}),
   * not stable account UUIDs.
   * @param clientId - Client whose last-seen fingerprint to look up
   * @returns The fingerprint string, or undefined
   */
  public getLastSeen(clientId: string): string | undefined {
    return this._lastSeen.get(clientId);
  }

  /**
   * Records the last-seen fingerprint for a client.
   *
   * Stores the raw credential fingerprint, not the stable account UUID.
   * @param clientId - Client to record
   * @param fingerprint - Fingerprint that was last observed
   */
  public setLastSeen(clientId: string, fingerprint: string): void {
    this._lastSeen.set(clientId, fingerprint);
  }

  /**
   * Removes the last-seen fingerprint entry for a client.
   *
   * Called when the credential disappears or the source becomes unavailable,
   * so the next poll re-evaluates from scratch rather than treating the stale
   * fingerprint as unchanged.
   * @param clientId - Client whose cached fingerprint should be cleared
   */
  public deleteLastSeen(clientId: string): void {
    this._lastSeen.delete(clientId);
  }

  /**
   * Polls all credential sources for changes.
   *
   * Account identity is matched by {@link StoredAccount.fingerprint} (the
   * dedup key recomputed from the credential on every read). The stable
   * {@link StoredAccount.id} (UUID assigned at first detection) is returned
   * as `activatedAccountId` and used for downstream fanout.
   *
   * Four detection cases:
   * 1. Known + active → token refresh (accessToken rotated, same account)
   * 2. Known + inactive → user switched back to a previously seen account
   * 3. Unknown fingerprint, matching credential key → fingerprint reconciliation
   * 4. Unknown fingerprint, no credential key match → new account detected
   */
  public async poll(): Promise<void> {
    for (const source of this.sources) {
      try {
        // The mutation block returns the accountId that changed (if any).
        // Credential fanout runs outside the lock to prevent deadlock:
        // emitCredentialChangedForClient → credential.changed →
        // agent.credential.change → credential.activate → withClientMutation (same client).
        const changedAccountId = await this.withClientMutation(source.clientId, async () => {
          if (!(await source.isAvailable())) {
            const active = await this.metadataStore.getActive(source.clientId);
            if (active) {
              await this.metadataStore.upsert(source.clientId, { ...active, active: false });
              this._lastSeen.delete(source.clientId);
            }
            return undefined;
          }
          const current = await source.read();
          if (!current) {
            // Credential disappeared (e.g. user logged out) — deactivate
            // any stored active account so the UI reflects the real state.
            const active = await this.metadataStore.getActive(source.clientId);
            if (active) {
              await this.metadataStore.upsert(source.clientId, { ...active, active: false });
              this._lastSeen.delete(source.clientId);
            }
            return undefined;
          }

          const accounts = await listStoredAccounts(this.metadataStore, this.credentialStore, source.clientId);
          const match = accounts.find((a) => a.fingerprint === current.fingerprint);
          const lastFingerprint = this._lastSeen.get(source.clientId);
          const unchanged =
            current.fingerprint === lastFingerprint &&
            match?.active === true &&
            match.credential.token === current.token &&
            jsonValuesEqual(match.credential.metadata, current.metadata);

          // Account identity is fingerprint-based, but the source payload can still
          // change for the active account. Only skip when token and metadata are
          // unchanged. Even when the payload is unchanged, emit for label resolution by
          // LabelResolver (handled by its subscription to credentials.refreshed).
          if (unchanged) {
            if (match && !match.label) {
              // Emit a refreshed event so LabelResolver can retry.
              await this.bus.emit(AccountManagerSubjects.credentials.refreshed, {
                clientId: source.clientId,
                account: toPublicAccount(match),
                reason: 'label-retry',
              });
            }
            return undefined;
          }

          let activatedAccountId: string;
          if (match && match.active) {
            await this.handleCredentialRefresh(source.clientId, match, current);
            activatedAccountId = match.id;
          } else if (match && !match.active) {
            await this.handleKnownAccountSwitch(source.clientId, accounts, match, current);
            activatedAccountId = match.id;
          } else {
            // Secondary dedup: when the source supports extractCredentialKey,
            // check if any existing stored account's credential produces the
            // same key. This catches fingerprint-format transitions (e.g.,
            // UUID → hash on cold start with an expired access token).
            const reconciledMatch = findAccountByCredentialKey(source, accounts, current);
            if (reconciledMatch) {
              // Fingerprint changed but the underlying credential key matches —
              // reconcile the stored account to the new fingerprint identity.
              activatedAccountId = await this.reconcileFingerprint(source.clientId, accounts, reconciledMatch, current);
            } else {
              activatedAccountId = await this.handleNewAccount(source, accounts, current);
            }
          }

          // Cache fingerprint only after successful reconciliation so
          // transient failures don't suppress retry on the next poll.
          this._lastSeen.set(source.clientId, current.fingerprint);
          return activatedAccountId;
        });

        if (changedAccountId !== undefined) {
          await emitCredentialChangedForClient(this.bus, source.clientId, changedAccountId);
        }
      } catch (error) {
        await this.bus.emit(AccountManagerSubjects.credentials.error, {
          clientId: source.clientId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Handles a credential refresh for a known active account.
   *
   * The active account identity stayed the same, but the underlying source
   * credential changed. This includes token rotation and metadata-only refreshes.
   * Updates the stored credential and emits `credentials.refreshed`.
   * @param clientId - The client identifier
   * @param account - The matched active account
   * @param current - The current credential from the source
   */
  private async handleCredentialRefresh(
    clientId: string,
    account: StoredAccount,
    current: RawCredential,
  ): Promise<void> {
    account.credential = current;
    account.fingerprint = current.fingerprint;
    const mergeResult = mergeSourceAccountMetadataWithIdentityCheck(account.metadata, current.metadata);
    account.metadata = mergeResult.metadata;
    if (mergeResult.identityChanged) {
      account.label = undefined;
    }
    account.lastSeenAt = Date.now();
    await upsertStoredAccount(this.metadataStore, this.credentialStore, clientId, account);

    await this.bus.emit(AccountManagerSubjects.credentials.refreshed, {
      clientId,
      account: toPublicAccount(account),
      reason: 'credential-updated',
    });
    // Credential fanout is deferred to the caller (outside withClientMutation)
    // to prevent deadlock: emitCredentialChangedForClient → credential.changed →
    // agent.credential.change → credential.activate → withClientMutation (same client).
  }

  /**
   * Commit one poll-driven activation and publish its primary event.
   *
   * The activation event is the transaction boundary for poll-driven state
   * changes: if publication fails after durable activation succeeds, Makaio's
   * durable state is restored to the last known good snapshot before the poll
   * can observe the new account as active.
   * @param clientId - Client whose active account is changing
   * @param accounts - Caller-owned joined snapshot
   * @param target - Account that should become active
   * @param activatedAt - Effective activation timestamp
   * @param reason - Timeline row reason
   * @param publishActivation - Callback that publishes the activation event
   */
  private async commitActivationAndPublish(
    clientId: string,
    accounts: StoredAccount[],
    target: StoredAccount,
    activatedAt: number,
    reason: AccountTimelineReason,
    publishActivation: (fromPayload: Account | null) => Promise<void>,
  ): Promise<void> {
    const previousActive = accounts.find((a) => a.active) ?? null;
    const previousTarget = accounts.find((a) => a.id === target.id) ?? null;
    const previousActiveSnapshot = previousActive ? structuredClone(previousActive) : null;
    const previousTargetSnapshot = previousTarget ? structuredClone(previousTarget) : null;
    const fromPayload = previousActive ? toPublicAccount(previousActive) : null;

    await commitActivatedAccountState({
      metadataStore: this.metadataStore,
      credentialStore: this.credentialStore,
      clientId,
      accounts,
      target,
      activatedAt,
    });

    try {
      await publishActivation(fromPayload);
    } catch (error) {
      try {
        await rollbackActivatedAccountState({
          metadataStore: this.metadataStore,
          credentialStore: this.credentialStore,
          clientId,
          targetId: target.id,
          previousTarget: previousTargetSnapshot,
          previousActive: previousActiveSnapshot,
        });
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Credential tracker activation failed after durable state changed, and rollback could not restore the previous state.',
        );
      }
      throw error;
    }

    await appendActivationTimelineBestEffort(
      this.metadataStore,
      {
        clientId,
        fromAccountId: previousActive?.id ?? null,
        toAccountId: target.id,
        effectiveAt: activatedAt,
        reason,
      },
      '[CredentialTracker] timeline append failed after successful activation:',
    );
  }

  /**
   * Handles a switch back to a known inactive account.
   *
   * The user logged into a previously seen account via the tool's native CLI.
   * Deactivates all accounts and activates the matched one. Emits `credentials.switched`.
   * @param clientId - The client identifier
   * @param accounts - All accounts for this client
   * @param match - The matched inactive account
   * @param current - The current credential from the source
   */
  private async handleKnownAccountSwitch(
    clientId: string,
    accounts: StoredAccount[],
    match: StoredAccount,
    current: RawCredential,
  ): Promise<void> {
    const switchedAt = Date.now();
    const mergeResult = mergeSourceAccountMetadataWithIdentityCheck(match.metadata, current.metadata);
    const updatedMatch: StoredAccount = {
      ...match,
      fingerprint: current.fingerprint,
      credential: current,
      metadata: mergeResult.metadata,
      label: mergeResult.identityChanged ? undefined : match.label,
    };

    await this.commitActivationAndPublish(
      clientId,
      accounts,
      updatedMatch,
      switchedAt,
      'switch',
      async (fromPayload) => {
        await this.bus.emit(AccountManagerSubjects.credentials.switched, {
          clientId,
          from: fromPayload,
          to: toPublicAccount(updatedMatch),
        });
      },
    );
    // Credential fanout deferred to caller — see handleCredentialRefresh comment.
  }

  /**
   * Handles detection of a new, never-seen-before account.
   *
   * Creates a new account entry with a stable UUID as `id` and the credential's
   * fingerprint stored separately. Emits `credentials.detected` so LabelResolver
   * and UsageTracker can react.
   * Performs one inline automatic-label attempt before publishing the
   * detection event so consumers can trust `autoLabeled` immediately instead
   * of racing a later retry loop.
   * @param source - The credential source that produced the account
   * @param accounts - All existing accounts for this client
   * @param current - The new credential from the source
   * @returns The stable UUID assigned to the new account
   */
  private async handleNewAccount(
    source: CredentialSourceWithOptionalLabel,
    accounts: StoredAccount[],
    current: RawCredential,
  ): Promise<string> {
    const detectedAt = Date.now();
    const newAccount: StoredAccount = {
      id: randomUUID(),
      fingerprint: current.fingerprint,
      label: undefined,
      metadata: mergeSourceAccountMetadata({}, current.metadata),
      active: true,
      detectedAt,
      lastSeenAt: detectedAt,
      credential: current,
    };

    const autoLabel = await this.resolveInitialLabel(source, current);
    if (autoLabel) {
      newAccount.label = autoLabel;
    }

    await this.commitActivationAndPublish(source.clientId, accounts, newAccount, detectedAt, 'detected', async () => {
      await this.bus.emit(AccountManagerSubjects.credentials.detected, {
        clientId: source.clientId,
        account: toPublicAccount(newAccount),
        autoLabeled: autoLabel !== null,
      });
    });
    if (autoLabel) {
      await this.emitAutoLabeledBestEffort(source.clientId, newAccount);
    }
    // Credential fanout deferred to caller — see handleCredentialRefresh comment.
    return newAccount.id;
  }

  /**
   * Publishes the auxiliary labeled event for an inline auto-label.
   *
   * The durable activation plus `credentials.detected` publication is the
   * invariant-bearing activation boundary. A later `accounts.labeled` failure
   * must not roll the account back after subscribers have already observed the
   * successful detection event carrying the label.
   * @param clientId - Client identifier for the detected account
   * @param account - Newly detected account with an inline auto-label
   */
  private async emitAutoLabeledBestEffort(clientId: string, account: StoredAccount): Promise<void> {
    try {
      await this.bus.emit(AccountManagerSubjects.accounts.labeled, {
        clientId,
        account: toPublicAccount(account),
      });
    } catch (error) {
      console.warn('[CredentialTracker] accounts.labeled emit failed after successful detection:', error);
    }
  }

  /**
   * Attempts one best-effort label lookup during first detection.
   *
   * The dedicated {@link LabelResolver} remains the retry owner for accounts
   * that stay unlabeled after this initial attempt.
   * @param source - Credential source that may resolve labels
   * @param credential - Newly detected credential
   * @returns Resolved label, or null when no automatic label is available
   */
  private async resolveInitialLabel(
    source: CredentialSourceWithOptionalLabel,
    credential: RawCredential,
  ): Promise<string | null> {
    if (typeof source.resolveLabel !== 'function') return null;
    try {
      const raw = await source.resolveLabel(credential);
      // Collapse empty and whitespace-only labels to null so the downstream
      // `autoLabeled` signal and the `if (autoLabel)` persistence guard stay
      // in lockstep — a blank label must not be treated as auto-resolved.
      const trimmed = raw?.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  }

  /**
   * Reconciles a stored account to a new fingerprint identity.
   *
   * Used when `extractCredentialKey` confirms that a "new" fingerprint and an
   * existing stored account refer to the same underlying credential (e.g., after
   * a UUID → hash fingerprint transition on cold start). The account is updated
   * in place — the stable UUID `id` is preserved while only the `fingerprint`
   * and credential payload are refreshed. Emits `credentials.switched`.
   * @param clientId - The client identifier
   * @param accounts - All currently stored accounts for this client
   * @param oldAccount - The stored account being reconciled
   * @param current - The incoming credential with the new fingerprint
   * @returns The stable UUID of the reconciled account
   */
  private async reconcileFingerprint(
    clientId: string,
    accounts: StoredAccount[],
    oldAccount: StoredAccount,
    current: RawCredential,
  ): Promise<string> {
    const switchedAt = Date.now();
    const mergeResult = mergeSourceAccountMetadataWithIdentityCheck(oldAccount.metadata, current.metadata);
    const updatedAccount: StoredAccount = {
      ...oldAccount,
      fingerprint: current.fingerprint,
      credential: current,
      metadata: mergeResult.metadata,
      label: mergeResult.identityChanged ? undefined : oldAccount.label,
    };

    await this.commitActivationAndPublish(
      clientId,
      accounts,
      updatedAccount,
      switchedAt,
      'switch',
      async (fromPayload) => {
        await this.bus.emit(AccountManagerSubjects.credentials.switched, {
          clientId,
          from: fromPayload,
          to: toPublicAccount(updatedAccount),
        });
      },
    );
    // Credential fanout deferred to caller — see handleCredentialRefresh comment.
    return updatedAccount.id;
  }

  /**
   * Merges historical duplicate accounts before the first poll runs.
   *
   * Over the lifetime of a credential source the same identity can accumulate
   * multiple {@link StoredAccount} rows due to fingerprint-format transitions
   * (e.g. UUID ↔ hash). This method scans every client's account list once at
   * startup and collapses those duplicates so that the normal poll path never
   * has to deal with them.
   *
   * Two accounts are considered duplicates when ANY of the following are true:
   * - `a.fingerprint === b.fingerprint` — same dedup key stored twice
   * - `a.fingerprint === b.id` — ghost account whose fingerprint matches a
   *   real account's stable UUID (the key cross-reference from the actual bug)
   * - `b.fingerprint === a.id` — symmetric of the above
   * - `a.credential.token === b.credential.token` — identical token payload
   *   despite differing fingerprints
   *
   * The survivor is chosen by {@link pickSurvivor}. After all losers are
   * removed, at most one account may remain active; if multiple are, only the
   * most recently seen one is kept active.
   *
   * Each client's work runs inside {@link withClientMutation} to serialize
   * against concurrent poll/switch operations.
   */
  private async bootstrapDedup(): Promise<void> {
    for (const source of this.sources) {
      try {
        await this.withClientMutation(source.clientId, async () => {
          const accounts = await listStoredAccounts(this.metadataStore, this.credentialStore, source.clientId);
          const canonical = canonicalizeBootstrapAccounts(accounts);

          for (const survivor of canonical.accounts) {
            await upsertStoredAccount(this.metadataStore, this.credentialStore, source.clientId, survivor);
          }

          for (const accountId of canonical.removedAccountIds) {
            await removeStoredAccount(this.metadataStore, this.credentialStore, source.clientId, accountId);
          }
        });
      } catch (error) {
        await this.bus.emit(AccountManagerSubjects.credentials.error, {
          clientId: source.clientId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
