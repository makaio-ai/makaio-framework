import type { IMakaioBus } from '@makaio/bus-core';
import type { IAccountCredentialStore, IAccountMetadataStore, StoredAccount } from './interfaces/account-store.js';
import type { PreparedNativeCredentialMutation } from './interfaces/credential-source.js';
import type { CredentialSourceWithOptionalLabel } from './handlers/credential-tracker-types.js';
import { AccountManagerSubjects } from './bus/namespace.js';
import { toPublicAccount } from './utils/index.js';
import { getStoredAccount, listStoredAccounts, removeStoredAccount } from './storage/joined-account-store.js';
import { commitActivatedAccountState, rollbackActivatedAccountState } from './storage/activation-state.js';
import { buildPreparedAccountRollbackSnapshot, prepareStoredAccountCredential } from './native-credential.js';
import { mergeSourceAccountMetadata } from './utils/source-account-metadata.js';
import { AccountManagerQuiesceError } from './account-manager-types.js';

/**
 * Dependencies for {@link switchAccount} and {@link activateAccount}.
 */
export interface AccountActivationDeps {
  /** Public metadata persistence layer. */
  metadataStore: IAccountMetadataStore;
  /** Credential persistence layer. */
  credentialStore: IAccountCredentialStore;
  /** Credential source for the target client. */
  source: CredentialSourceWithOptionalLabel;
  /**
   * Records the last-seen credential fingerprint after a successful activation.
   * @param clientId - Client to record
   * @param fingerprint - Fingerprint that was last observed
   */
  setLastSeen(clientId: string, fingerprint: string): void;
  /**
   * Clears derived-state caches for a removed or zombie account.
   * @param clientId - Client whose caches should be cleared
   * @param accountId - Account being removed
   * @param fingerprint - Fingerprint of the removed account
   * @returns Promise that settles once account-owned tracker work has drained
   */
  clearDerivedState(clientId: string, accountId: string, fingerprint: string): Promise<void>;
  /** Bus instance for emitting switch and credential-changed events. */
  bus: IMakaioBus;
}

/** Prepared account switch whose native and durable mutations await one terminal decision. */
export interface PreparedAccountActivation {
  /** Account materialized into the client's native store. */
  readonly account: StoredAccount;
  /** Commit timeline/tracker state, rolling back account state if finalization fails. */
  commit(): Promise<void>;
  /** Restore the exact previous manager-owned native and durable state. */
  rollback(): Promise<void>;
}

/** Commit policy for auxiliary activation metadata. */
export interface PrepareAccountActivationOptions {
  /** Keep timeline writes best-effort for user-initiated standalone switches. */
  readonly timelineFailure?: 'rollback' | 'ignore';
}

/** State captured after durable/native preparation and before terminal finalization. */
interface PreparedActivationState {
  /** Target account containing the credential written to native storage. */
  readonly target: StoredAccount;
  /** Account selected before preparation, when one existed. */
  readonly previousActiveId: string | null;
  /** Exact previous active account snapshot for durable rollback. */
  readonly previousActive: StoredAccount | null;
  /** Source-owned native write whose rollback is generation guarded. */
  readonly nativeMutation: PreparedNativeCredentialMutation;
  /** Target snapshot reconciled with any prepared credential refresh. */
  readonly rollbackTarget: StoredAccount;
  /** Timestamp applied to durable activation state. */
  readonly activatedAt: number;
}

/** Stable terminal account-activation failure without credential-bearing causes. */
export class AccountActivationFinalizationError extends Error {
  /**
   * @param code - Stable commit/rollback failure category.
   */
  public constructor(public readonly code: 'commit-failed' | 'commit-rollback-failed' | 'rollback-failed') {
    super(`Account activation finalization failed (${code}).`);
    this.name = 'AccountActivationFinalizationError';
  }
}

/**
 * Switches the active account for a client.
 *
 * Writes the target account's credential to the client's native location,
 * updates the store, and emits the accountSwitched event. Credential fanout
 * is deferred to the caller outside the mutation lock — see CredentialTracker
 * poll() comment on deadlock avoidance.
 * @param clientId - The client identifier
 * @param accountId - The account to switch to
 * @param deps - Injected dependencies
 * @returns The activated account ID, or undefined if already active
 */
export async function switchAccount(
  clientId: string,
  accountId: string,
  deps: AccountActivationDeps,
): Promise<string | undefined> {
  const { metadataStore, credentialStore, bus } = deps;
  const target = await getStoredAccount(metadataStore, credentialStore, clientId, accountId);
  if (!target) throw new Error(`Account ${accountId} not found for ${clientId}`);

  const accounts = await listStoredAccounts(metadataStore, credentialStore, clientId);
  const prev = accounts.find((a) => a.active) ?? null;

  if (prev?.id === accountId) return undefined; // already active

  // Snapshot before activateAccount → deactivateAll mutates stored objects.
  const fromPayload = prev ? toPublicAccount(prev) : null;
  const activatedAccount = await activateAccount(clientId, accountId, deps, accounts, target);

  await bus.emit(AccountManagerSubjects.credentials.switched, {
    clientId,
    from: fromPayload,
    to: toPublicAccount(activatedAccount),
  });
  // Credential fanout deferred to caller — see poll() comment.
  return activatedAccount.id;
}

/**
 * Commits the selected account as active and aligns the native store.
 *
 * The flow re-reads the keychain, refreshes when possible, commits Makaio
 * state first, then rolls that durable state back if the later native write
 * fails. This prevents stale or mismatched tokens from reaching
 * {@link emitCredentialChangedForClient}.
 * @param clientId - Client whose native store should be prepared
 * @param accountId - Account that should become active in native storage
 * @param deps - Injected dependencies
 * @param existingAccounts - Optional preloaded account list
 * @param preloadedTarget - Optional already-loaded target account
 * @returns The activated stored account with the freshest safe credential
 */
export async function activateAccount(
  clientId: string,
  accountId: string,
  deps: AccountActivationDeps,
  existingAccounts?: StoredAccount[],
  preloadedTarget?: StoredAccount,
): Promise<StoredAccount> {
  const prepared = await prepareAccountActivation(clientId, accountId, deps, existingAccounts, preloadedTarget, {
    timelineFailure: 'ignore',
  });
  await prepared.commit();
  return prepared.account;
}

/**
 * Prepare a reversible account activation while the caller owns the per-client mutation lock.
 *
 * The target credential is refreshed, persisted, and written to the native
 * client store before this function returns so a replacement connector can
 * materialize it. Timeline and tracker state are committed only after the
 * replacement is ready. Rollback restores the previous account selected by
 * manager state; it never guesses from a provider context.
 * @param clientId - Client whose native store should be prepared
 * @param accountId - Account that should become active in native storage
 * @param deps - Injected dependencies
 * @param existingAccounts - Optional preloaded account list
 * @param preloadedTarget - Optional already-loaded target account
 * @param options - Finalization policy; transactional callers use strict rollback
 * @returns Reversible activation handle awaiting exactly one terminal action
 */
export async function prepareAccountActivation(
  clientId: string,
  accountId: string,
  deps: AccountActivationDeps,
  existingAccounts?: StoredAccount[],
  preloadedTarget?: StoredAccount,
  options: PrepareAccountActivationOptions = {},
): Promise<PreparedAccountActivation> {
  const state = await prepareActivationState(clientId, accountId, deps, existingAccounts, preloadedTarget);
  return createPreparedActivation(clientId, deps, state, options);
}

/**
 * Prepare durable and native account state while the caller owns the client lock.
 * @param clientId - Client whose native account is selected.
 * @param accountId - Exact account to materialize.
 * @param deps - Account activation dependencies.
 * @param existingAccounts - Optional preloaded account list.
 * @param preloadedTarget - Optional already-loaded target account.
 * @returns State required for commit or rollback finalization.
 */
async function prepareActivationState(
  clientId: string,
  accountId: string,
  deps: AccountActivationDeps,
  existingAccounts?: StoredAccount[],
  preloadedTarget?: StoredAccount,
): Promise<PreparedActivationState> {
  const { metadataStore, credentialStore, source, clearDerivedState } = deps;
  const target = preloadedTarget ?? (await getStoredAccount(metadataStore, credentialStore, clientId, accountId));
  if (!target) throw new Error(`Account ${accountId} not found for ${clientId}`);
  const accounts = existingAccounts ?? (await listStoredAccounts(metadataStore, credentialStore, clientId));
  const previousActive = accounts.find((account) => account.active) ?? null;
  const previousTargetSnapshot = structuredClone(target);
  const previousActiveSnapshot = previousActive ? structuredClone(previousActive) : null;
  const prepared = await prepareStoredAccountCredential(source, target, clientId, accountId);
  if (prepared.status === 'failed') {
    await removeStoredAccount(metadataStore, credentialStore, clientId, accountId);
    throw new AccountManagerQuiesceError(prepared.reason, clearDerivedState(clientId, accountId, target.fingerprint));
  }
  if (prepared.refreshStatus === 'transient') {
    console.warn(
      `[AccountManager] activateAccount — transient refresh failure for ${clientId}:${accountId}: ${prepared.refreshReason}`,
    );
  }

  target.credential = prepared.credential;
  target.fingerprint = prepared.credential.fingerprint;
  target.metadata = mergeSourceAccountMetadata(target.metadata, prepared.credential.metadata);
  const activatedAt = Date.now();
  const rollbackTarget = buildPreparedAccountRollbackSnapshot(previousTargetSnapshot, prepared.credential);
  await commitActivatedAccountState({ metadataStore, credentialStore, clientId, accounts, target, activatedAt });

  let nativeMutation: PreparedNativeCredentialMutation;
  try {
    nativeMutation = await source.prepareNativeCredentialMutation(target.credential);
  } catch (error) {
    try {
      await rollbackActivatedAccountState({
        metadataStore,
        credentialStore,
        clientId,
        previousTarget: rollbackTarget,
        previousActive: previousActiveSnapshot,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Account activation failed after durable state changed, and rollback could not restore the previous state.',
        { cause: rollbackError },
      );
    }
    throw error;
  }

  const state: PreparedActivationState = {
    target,
    previousActiveId: previousActiveSnapshot?.id ?? null,
    previousActive: previousActiveSnapshot,
    nativeMutation,
    rollbackTarget,
    activatedAt,
  };
  if (nativeMutation.coordination === 'uncertain') {
    try {
      await restoreActivationState(clientId, deps, state);
    } catch (error) {
      if (error instanceof AccountActivationFinalizationError) throw error;
      throw new AccountActivationFinalizationError('rollback-failed');
    }
    throw new Error('Native account activation coordination was uncertain; the prepared activation was restored.');
  }
  return state;
}

/**
 * Restore the exact manager-owned native and durable state captured before preparation.
 * @param clientId - Client whose state is restored.
 * @param deps - Account activation dependencies.
 * @param state - Prepared state carrying rollback snapshots.
 * @returns Promise that resolves after both restore paths succeed.
 */
async function restoreActivationState(
  clientId: string,
  deps: AccountActivationDeps,
  state: PreparedActivationState,
): Promise<void> {
  const rollbackErrors: Error[] = [];
  let restoreDurableState = false;
  try {
    const nativeRollback = await state.nativeMutation.rollback();
    restoreDurableState = nativeRollback.status === 'restored';
    if (nativeRollback.status === 'superseded') {
      rollbackErrors.push(new Error('Native account rollback was superseded by a newer credential generation.'));
    } else if (nativeRollback.coordination === 'uncertain') {
      rollbackErrors.push(new Error('Native account rollback coordination is uncertain.'));
    }
  } catch {
    rollbackErrors.push(new Error('Native account rollback failed.'));
  }
  if (restoreDurableState) {
    try {
      await rollbackActivatedAccountState({
        metadataStore: deps.metadataStore,
        credentialStore: deps.credentialStore,
        clientId,
        previousTarget: state.rollbackTarget,
        previousActive: state.previousActive,
      });
    } catch {
      rollbackErrors.push(new Error('Durable account rollback failed.'));
    }
  }
  if (rollbackErrors.length === 1) throw new AccountActivationFinalizationError('rollback-failed');
  if (rollbackErrors.length > 1) {
    throw new AggregateError(rollbackErrors, 'Native and durable account activation rollback both failed.');
  }
}

/**
 * Commit timeline and tracker metadata after a replacement connector is ready.
 * @param clientId - Client whose activation is committed.
 * @param deps - Account activation dependencies.
 * @param state - Prepared state being committed.
 * @param options - Timeline failure policy.
 * @returns Promise that resolves after commit metadata is recorded.
 */
async function commitActivationMetadata(
  clientId: string,
  deps: AccountActivationDeps,
  state: PreparedActivationState,
  options: PrepareAccountActivationOptions,
): Promise<void> {
  if (state.previousActiveId !== state.target.id) {
    const entry = {
      clientId,
      fromAccountId: state.previousActiveId,
      toAccountId: state.target.id,
      effectiveAt: state.activatedAt,
      reason: 'switch' as const,
    };
    if (options.timelineFailure === 'ignore') {
      try {
        await deps.metadataStore.appendTimeline(entry);
      } catch (error) {
        console.warn('[AccountManager] timeline append failed after successful activation:', error);
      }
    } else {
      await deps.metadataStore.appendTimeline(entry);
    }
  }
  deps.setLastSeen(clientId, state.target.fingerprint);
}

/**
 * Build the single-terminal-action handle returned to an activation transaction.
 * @param clientId - Client whose activation awaits finalization.
 * @param deps - Account activation dependencies.
 * @param state - Prepared activation state.
 * @param options - Timeline failure policy.
 * @returns Reversible activation handle.
 */
function createPreparedActivation(
  clientId: string,
  deps: AccountActivationDeps,
  state: PreparedActivationState,
  options: PrepareAccountActivationOptions,
): PreparedAccountActivation {
  let terminal: { readonly action: 'commit' | 'rollback'; readonly promise: Promise<void> } | undefined;
  const finalize = (action: 'commit' | 'rollback', operation: () => Promise<void>): Promise<void> => {
    if (terminal !== undefined) {
      if (terminal.action !== action) {
        return Promise.reject(new Error('Account activation already received a different terminal action.'));
      }
      return terminal.promise;
    }
    const promise = operation();
    terminal = { action, promise };
    return promise;
  };

  return {
    account: state.target,
    commit: () =>
      finalize('commit', async () => {
        try {
          await commitActivationMetadata(clientId, deps, state, options);
        } catch {
          try {
            await restoreActivationState(clientId, deps, state);
          } catch {
            throw new AccountActivationFinalizationError('commit-rollback-failed');
          }
          throw new AccountActivationFinalizationError('commit-failed');
        }
      }),
    rollback: () =>
      finalize('rollback', async () => {
        try {
          await restoreActivationState(clientId, deps, state);
        } catch (error) {
          if (error instanceof AccountActivationFinalizationError) throw error;
          throw new AccountActivationFinalizationError('rollback-failed');
        }
      }),
  };
}
