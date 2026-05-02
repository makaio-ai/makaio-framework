import type { Account } from '../bus/schemas.js';
import type {
  IAccountCredentialStore,
  IAccountMetadataStore,
  StoredAccount,
  StoredAccountCredential,
} from '../interfaces/account-store.js';
import { toPublicAccount } from '../utils/to-public-account.js';

/**
 * Joins one public metadata row with its credential row.
 * @param account - Public account metadata row
 * @param credential - Credential row sharing the same stable account id
 * @returns Internal joined account aggregate
 */
export function joinStoredAccount(account: Account, credential: StoredAccountCredential): StoredAccount {
  return {
    ...account,
    credential: credential.credential,
    fingerprint: credential.fingerprint,
  };
}

/**
 * Lists joined accounts for one client.
 * @param metadataStore - Public metadata store
 * @param credentialStore - Credential store
 * @param clientId - Stable client identifier
 * @returns Joined accounts that have both metadata and credential rows
 */
export async function listStoredAccounts(
  metadataStore: IAccountMetadataStore,
  credentialStore: IAccountCredentialStore,
  clientId: string,
): Promise<StoredAccount[]> {
  const [metadataAccounts, credentialAccounts] = await Promise.all([
    metadataStore.list(clientId),
    credentialStore.list(clientId),
  ]);
  const credentialsById = new Map(credentialAccounts.map((account) => [account.id, account]));
  return metadataAccounts.flatMap((account) => {
    const credential = credentialsById.get(account.id);
    return credential ? [joinStoredAccount(account, credential)] : [];
  });
}

/**
 * Retrieves one joined account.
 * @param metadataStore - Public metadata store
 * @param credentialStore - Credential store
 * @param clientId - Stable client identifier
 * @param accountId - Stable account identifier
 * @returns Joined account, or null when either side is absent
 */
export async function getStoredAccount(
  metadataStore: IAccountMetadataStore,
  credentialStore: IAccountCredentialStore,
  clientId: string,
  accountId: string,
): Promise<StoredAccount | null> {
  const [metadata, credential] = await Promise.all([
    metadataStore.get(clientId, accountId),
    credentialStore.get(clientId, accountId),
  ]);
  return metadata && credential ? joinStoredAccount(metadata, credential) : null;
}

/**
 * Retrieves one joined account together with the metadata generation captured from the same metadata row snapshot.
 * @param metadataStore - Public metadata store
 * @param credentialStore - Credential store
 * @param clientId - Stable client identifier
 * @param accountId - Stable account identifier
 * @returns Joined account plus generation, or null when either side is absent
 */
export async function getStoredAccountWithGeneration(
  metadataStore: IAccountMetadataStore,
  credentialStore: IAccountCredentialStore,
  clientId: string,
  accountId: string,
): Promise<{ account: StoredAccount; metadataGeneration: number } | null> {
  const [metadata, credential] = await Promise.all([
    metadataStore.getWithMetadataGeneration(clientId, accountId),
    credentialStore.get(clientId, accountId),
  ]);
  return metadata && credential
    ? {
        account: joinStoredAccount(metadata.account, credential),
        metadataGeneration: metadata.metadataGeneration,
      }
    : null;
}

/**
 * Upserts both sides of one joined account.
 * @param metadataStore - Public metadata store
 * @param credentialStore - Credential store
 * @param clientId - Stable client identifier
 * @param account - Joined account aggregate to persist
 */
export async function upsertStoredAccount(
  metadataStore: IAccountMetadataStore,
  credentialStore: IAccountCredentialStore,
  clientId: string,
  account: StoredAccount,
): Promise<void> {
  // Joined account persistence spans two independent durability domains:
  // native credential bytes and public metadata. Credentials are written first
  // so partial failures leave at most a hidden credential orphan, and this
  // helper surfaces the error instead of attempting fake rollback through a
  // second split-store mutation with the same failure mode.
  await credentialStore.upsert(clientId, {
    id: account.id,
    credential: account.credential,
    fingerprint: account.fingerprint,
  });
  await metadataStore.upsert(clientId, toPublicAccount(account));
}

/**
 * Removes both sides of one joined account.
 * @param metadataStore - Public metadata store
 * @param credentialStore - Credential store
 * @param clientId - Stable client identifier
 * @param accountId - Stable account identifier to remove
 */
export async function removeStoredAccount(
  metadataStore: IAccountMetadataStore,
  credentialStore: IAccountCredentialStore,
  clientId: string,
  accountId: string,
): Promise<void> {
  // Removal keeps the same contract: metadata is deleted first so partial
  // failures hide the account from joined reads, and callers must retry or
  // reconcile after an error rather than assuming the helper can repair both
  // backends transactionally.
  await metadataStore.remove(clientId, accountId);
  await credentialStore.remove(clientId, accountId);
}
