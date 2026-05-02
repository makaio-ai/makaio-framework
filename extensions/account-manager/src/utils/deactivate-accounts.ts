import type { IAccountMetadataStore, StoredAccount } from '../interfaces/account-store.js';

/**
 * Marks all currently-active accounts as inactive and persists the change.
 *
 * Durable active state lives in metadata, so that store is cleared
 * unconditionally before the caller-owned joined snapshot is mutated in place.
 * The snapshot may be incomplete when metadata rows have lost their matching
 * credential rows, so callers must not rely on it to prove the durable store is
 * already inactive.
 * @param store - Account persistence layer used to flush changes
 * @param clientId - Client whose accounts are being deactivated
 * @param accounts - Account list to operate on (caller-owned, may be mutated)
 */
export async function deactivateAccounts(
  store: IAccountMetadataStore,
  clientId: string,
  accounts: StoredAccount[],
): Promise<void> {
  await store.deactivateAll(clientId);
  for (const account of accounts) {
    account.active = false;
  }
}
