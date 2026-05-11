import type { IMakaioBus } from '@makaio/bus-core';
import type { IAccountCredentialStore, IAccountMetadataStore, StoredAccount } from './interfaces/account-store.js';
import type { CredentialSourceWithOptionalLabel } from './handlers/credential-tracker-types.js';
import { AccountManagerSubjects } from './bus/namespace.js';
import { toPublicAccount } from './utils/index.js';
import { getStoredAccount, listStoredAccounts, removeStoredAccount } from './storage/joined-account-store.js';
import {
  appendActivationTimelineBestEffort,
  commitActivatedAccountState,
  rollbackActivatedAccountState,
} from './storage/activation-state.js';
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
  const { metadataStore, credentialStore, source, setLastSeen, clearDerivedState } = deps;
  const target = preloadedTarget ?? (await getStoredAccount(metadataStore, credentialStore, clientId, accountId));
  if (!target) throw new Error(`Account ${accountId} not found for ${clientId}`);
  const accounts = existingAccounts ?? (await listStoredAccounts(metadataStore, credentialStore, clientId));
  const previousActive = accounts.find((account) => account.active) ?? null;
  const previousActiveId = previousActive?.id ?? null;
  // Rollback must preserve prepared native credential reconciliations.
  const previousTargetSnapshot = structuredClone(target);
  const previousActiveSnapshot = previousActive ? structuredClone(previousActive) : null;
  const prepared = await prepareStoredAccountCredential(source, target, clientId, accountId);
  if (prepared.status === 'failed') {
    // The credential is irrecoverable (e.g. refresh token revoked).
    // Remove the zombie account so the TUI never shows it and no
    // future switch attempt can write a dead token to the keychain.
    await removeStoredAccount(metadataStore, credentialStore, clientId, accountId);
    throw new AccountManagerQuiesceError(prepared.reason, clearDerivedState(clientId, accountId, target.fingerprint));
  }
  if (prepared.refreshStatus === 'transient') {
    // The refresh endpoint was temporarily unreachable (5xx, timeout,
    // network error). The credential is not proven dead — proceed with
    // the existing credential and let the next activation cycle retry.
    console.warn(
      `[AccountManager] activateAccount — transient refresh failure for ${clientId}:${accountId}: ${prepared.refreshReason}`,
    );
  }
  const credential = prepared.credential;
  const rollbackTargetSnapshot = buildPreparedAccountRollbackSnapshot(previousTargetSnapshot, credential);

  // Update stored account with the (possibly refreshed) credential.
  target.credential = credential;
  target.fingerprint = credential.fingerprint;
  target.metadata = mergeSourceAccountMetadata(target.metadata, credential.metadata);
  const activatedAt = Date.now();

  await commitActivatedAccountState({
    metadataStore,
    credentialStore,
    clientId,
    accounts,
    target,
    activatedAt,
  });

  try {
    await source.write(target.credential);
  } catch (error) {
    try {
      await rollbackActivatedAccountState({
        metadataStore,
        credentialStore,
        clientId,
        previousTarget: rollbackTargetSnapshot,
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

  if (previousActiveId !== target.id) {
    await appendActivationTimelineBestEffort(
      metadataStore,
      {
        clientId,
        fromAccountId: previousActiveId,
        toAccountId: target.id,
        effectiveAt: activatedAt,
        reason: 'switch',
      },
      '[AccountManager] timeline append failed after successful activation:',
    );
  }

  setLastSeen(clientId, target.fingerprint);
  return target;
}
