import type { IAccountCredentialStore, IAccountMetadataStore } from '../interfaces/account-store.js';
import { getStoredAccount, listStoredAccounts } from '../storage/joined-account-store.js';
import { isUsageAuthInvalidForFingerprint } from '../utils/usage-auth-state.js';

/**
 * Resolves the account targets a `usage.refresh` request should start for.
 * @param sources - Registered usage sources keyed by client id
 * @param metadataStore - Public metadata store
 * @param credentialStore - Credential store
 * @param clientId - Optional client filter
 * @param accountId - Optional account filter
 * @returns Refresh targets that both exist and are backed by a usage source
 */
export async function collectUsageRefreshTargets(
  sources: Map<string, unknown>,
  metadataStore: IAccountMetadataStore,
  credentialStore: IAccountCredentialStore,
  clientId?: string,
  accountId?: string,
): Promise<Array<{ clientId: string; accountId: string }>> {
  if (clientId !== undefined && accountId !== undefined) {
    if (!sources.has(clientId)) {
      return [];
    }
    const account = await getStoredAccount(metadataStore, credentialStore, clientId, accountId);
    return account !== null && !isUsageAuthInvalidForFingerprint(account.metadata, account.fingerprint)
      ? [{ clientId, accountId }]
      : [];
  }

  const targets: Array<{ clientId: string; accountId: string }> = [];
  const clientIds = clientId !== undefined ? [clientId] : [...sources.keys()];
  for (const id of clientIds) {
    if (!sources.has(id)) continue;
    for (const account of await listStoredAccounts(metadataStore, credentialStore, id)) {
      if (isUsageAuthInvalidForFingerprint(account.metadata, account.fingerprint)) {
        continue;
      }
      targets.push({ clientId: id, accountId: account.id });
    }
  }
  return targets;
}
