import type {
  AccountTimelineEntry,
  IAccountCredentialStore,
  IAccountMetadataStore,
  StoredAccount,
} from '../interfaces/account-store.js';
import { removeStoredAccount, upsertStoredAccount } from './joined-account-store.js';
import { deactivateAccounts } from '../utils/deactivate-accounts.js';

/**
 * Dependencies for one durable activation-state commit.
 */
export interface ActivationStateCommitInput {
  /** Public metadata persistence layer. */
  metadataStore: IAccountMetadataStore;
  /** Credential persistence layer. */
  credentialStore: IAccountCredentialStore;
  /** Client whose active account is being updated. */
  clientId: string;
  /** Caller-owned joined snapshot used to clear prior active flags. */
  accounts: StoredAccount[];
  /** Account that should become active. */
  target: StoredAccount;
  /** Effective activation timestamp. */
  activatedAt: number;
}

/**
 * Snapshot needed to restore durable activation state after a later failure.
 */
export interface ActivationStateRollbackInput {
  /** Public metadata persistence layer. */
  metadataStore: IAccountMetadataStore;
  /** Credential persistence layer. */
  credentialStore: IAccountCredentialStore;
  /** Client whose state should be restored. */
  clientId: string;
  /**
   * Stable identifier of the activation target.
   *
   * Required when the target row did not exist before the failed activation
   * attempt, so rollback can remove the partially inserted account.
   */
  targetId?: string;
  /**
   * Target account before the failed activation attempt mutated it.
   *
   * Null when the failed activation created a brand-new account row.
   */
  previousTarget: StoredAccount | null;
  /** Previously active account before the failed activation attempt. */
  previousActive: StoredAccount | null;
}

/**
 * Commit one durable active-account transition.
 *
 * This owns the Makaio-side activation invariant: clear prior active rows,
 * mark the target active, and persist the target's current credential bytes.
 * Native credential-store writes happen outside this helper.
 * @param input - Activation commit inputs
 */
export async function commitActivatedAccountState(input: ActivationStateCommitInput): Promise<void> {
  const { metadataStore, credentialStore, clientId, accounts, target, activatedAt } = input;

  await deactivateAccounts(metadataStore, clientId, accounts);
  target.active = true;
  target.lastSeenAt = activatedAt;
  await upsertStoredAccount(metadataStore, credentialStore, clientId, target);
}

/**
 * Restore the durable activation state after a downstream failure.
 *
 * Replays the pre-activation snapshots for the target and previously-active
 * accounts so Makaio's durable state matches the last known good state.
 * @param input - Rollback inputs captured before the failed activation attempt
 */
export async function rollbackActivatedAccountState(input: ActivationStateRollbackInput): Promise<void> {
  const { metadataStore, credentialStore, clientId, previousTarget, previousActive } = input;
  const targetId = input.targetId ?? previousTarget?.id;
  if (!targetId) {
    throw new Error('rollbackActivatedAccountState requires targetId when previousTarget is null');
  }

  await metadataStore.deactivateAll(clientId);
  if (previousTarget) {
    await upsertStoredAccount(metadataStore, credentialStore, clientId, previousTarget);
  } else {
    await removeStoredAccount(metadataStore, credentialStore, clientId, targetId);
  }
  if (previousActive && previousActive.id !== targetId) {
    await upsertStoredAccount(metadataStore, credentialStore, clientId, previousActive);
  }
}

/**
 * Persist one activation timeline row without letting auxiliary history writes
 * fail the already-committed activation itself.
 * @param metadataStore - Public metadata store
 * @param entry - Timeline row to append
 * @param warningPrefix - Prefix used for the warning log
 */
export async function appendActivationTimelineBestEffort(
  metadataStore: IAccountMetadataStore,
  entry: AccountTimelineEntry,
  warningPrefix: string,
): Promise<void> {
  try {
    await metadataStore.appendTimeline(entry);
  } catch (error) {
    console.warn(warningPrefix, error);
  }
}
