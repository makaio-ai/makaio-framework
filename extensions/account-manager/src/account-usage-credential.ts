import type { IAccountCredentialStore, IAccountMetadataStore } from './interfaces/account-store.js';
import type { RawCredential } from './interfaces/credential-source.js';
import type { CredentialSourceWithOptionalLabel } from './handlers/credential-tracker-types.js';
import type { UsagePreparedCredential } from './handlers/usage-tracker-types.js';
import { getStoredAccount, upsertStoredAccount } from './storage/joined-account-store.js';
import { prepareStoredAccountCredential } from './native-credential.js';
import { mergeSourceAccountMetadata } from './utils/source-account-metadata.js';
import { isUsageAuthInvalidForFingerprint } from './utils/usage-auth-state.js';

/**
 * Prepares the freshest credential for a usage fetch for a given account.
 *
 * Refreshes the access token when the usage-auth state indicates the stored
 * credential has been rejected by the upstream API. Writes refreshed tokens
 * back to the client's native store when the account is active.
 * @param clientId - The client identifier
 * @param accountId - The account the credential must still belong to
 * @param source - Credential source for the target client
 * @param metadataStore - Public metadata persistence layer
 * @param credentialStore - Credential persistence layer
 * @returns Prepared credential outcome, or null when the account is not found
 */
export async function prepareUsageCredential(
  clientId: string,
  accountId: string,
  source: CredentialSourceWithOptionalLabel,
  metadataStore: IAccountMetadataStore,
  credentialStore: IAccountCredentialStore,
): Promise<UsagePreparedCredential | null> {
  const account = await getStoredAccount(metadataStore, credentialStore, clientId, accountId);
  if (!account) {
    console.warn(
      `[AccountManager] ${new Date().toISOString()} prepareUsageCredential ${clientId}:${accountId} — account not found`,
    );
    return null;
  }

  const forceRefresh = isUsageAuthInvalidForFingerprint(account.metadata, account.fingerprint);
  const prepared = await prepareStoredAccountCredential(
    source,
    account,
    clientId,
    accountId,
    forceRefresh ? { force: true } : undefined,
  );
  if (prepared.status === 'failed') {
    console.warn(
      `[AccountManager] ${new Date().toISOString()} prepareUsageCredential ${clientId}:${accountId} — credential invalid: ${prepared.reason}`,
    );
    return {
      status: 'invalid',
      credential: bindCredentialToStoredAccount(account.fingerprint, prepared.credential),
      reason: prepared.reason,
    };
  }

  if (prepared.refreshStatus === 'transient') {
    console.warn(
      `[AccountManager] prepareUsageCredential — transient refresh failure for ${clientId}:${accountId}: ${prepared.refreshReason}`,
    );
  }

  const credential =
    prepared.refreshStatus === 'refreshed'
      ? bindCredentialToStoredAccount(account.fingerprint, prepared.credential)
      : prepared.credential;
  const changed = hasCredentialChanged(account.credential, credential);

  console.info(
    `[AccountManager] ${new Date().toISOString()} prepareUsageCredential ${clientId}:${accountId} — refreshStatus=${prepared.refreshStatus}, changed=${changed}, active=${account.active}`,
  );

  if (!changed) {
    return { status: 'ready', credential, changed: false };
  }

  if (account.active && prepared.refreshStatus === 'refreshed') {
    await source.write(credential);
  }
  account.credential = credential;
  account.metadata = mergeSourceAccountMetadata(account.metadata, credential.metadata);
  account.fingerprint = credential.fingerprint;
  await upsertStoredAccount(metadataStore, credentialStore, clientId, account);

  return { status: 'ready', credential, changed: true };
}

/**
 * Pins the stored account's fingerprint onto a refreshed credential.
 *
 * When a usage credential refresh returns a new access token but the account
 * identity hasn't changed, the fingerprint from the stored account row is
 * preserved so downstream consumers can still identify the account by its
 * deduplication key.
 * @param storedFingerprint - The fingerprint of the stored account
 * @param credential - The refreshed or prepared credential
 * @returns A new credential object with the stored account's fingerprint
 */
export function bindCredentialToStoredAccount(storedFingerprint: string, credential: RawCredential): RawCredential {
  return {
    token: credential.token,
    fingerprint: storedFingerprint,
    metadata: credential.metadata,
  };
}

/**
 * Checks whether a credential's observable fields changed between two reads.
 *
 * Token rotation, fingerprint changes, and metadata mutations all count as
 * changes. Used to decide whether a background refresh needs to be written
 * back to persistent storage and the client's native store.
 * @param previous - The previously stored credential
 * @param next - The newly prepared credential
 * @returns `true` when any observable field differs
 */
export function hasCredentialChanged(previous: RawCredential, next: RawCredential): boolean {
  return (
    previous.token !== next.token ||
    previous.fingerprint !== next.fingerprint ||
    JSON.stringify(previous.metadata) !== JSON.stringify(next.metadata)
  );
}
