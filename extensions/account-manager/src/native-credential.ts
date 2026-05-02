import type { CredentialRefreshOptions, ICredentialSource, RawCredential } from './interfaces/credential-source.js';
import type { StoredAccount } from './interfaces/account-store.js';
import { mergeSourceAccountMetadata } from './utils/source-account-metadata.js';

/**
 * Shared outcome of preparing a stored account credential for activation or usage fetches.
 */
export type PreparedAccountCredentialResult =
  | {
      status: 'ready';
      credential: RawCredential;
      refreshStatus: 'unchanged' | 'refreshed' | 'transient';
      refreshReason?: string;
    }
  | {
      status: 'failed';
      credential: RawCredential;
      reason: string;
    };

/**
 * Returns whether a native credential can be verified to belong to a stored account.
 * @param source - Credential source for the client
 * @param account - Stored account we expect the credential to belong to
 * @param credential - Native credential candidate
 * @returns Whether the credential can be verified to belong to the stored account
 */
export function credentialBelongsToAccount(
  source: ICredentialSource,
  account: StoredAccount,
  credential: RawCredential,
): boolean {
  if (typeof source.extractCredentialKey === 'function') {
    const nativeKey = source.extractCredentialKey(credential.token);
    const accountKey = source.extractCredentialKey(account.credential.token);
    if (nativeKey === null || accountKey === null || nativeKey !== accountKey) return false;
    // No same-fingerprint short-circuit here: in the corruption scenario the
    // credential fingerprint can match the account fingerprint while the
    // underlying credential key points to a different identity.  The
    // allowsCredentialKeyFingerprintMismatch hook is the only safe gate.
    if (account.fingerprint.length === 0 || accountKey === account.fingerprint) return true;
    return (
      source.allowsCredentialKeyFingerprintMismatch?.({
        accountFingerprint: account.fingerprint,
        storedCredentialKey: accountKey,
        incomingFingerprint: credential.fingerprint,
        incomingCredentialKey: nativeKey,
      }) === true
    );
  }
  return credential.fingerprint.length > 0 && credential.fingerprint === account.fingerprint;
}

/**
 * Reads the freshest native credential for a stored account when ownership can
 * still be proven against the current native store contents.
 * @param source - Credential source that owns the native store
 * @param account - Stored account whose native credential should be re-read
 * @param clientId - Stable client identifier for diagnostic logging
 * @param accountId - Stable account identifier for diagnostic logging
 * @returns Verified native credential, or null when ownership cannot be proven
 */
export async function readVerifiedNativeCredential(
  source: ICredentialSource,
  account: StoredAccount,
  clientId: string,
  accountId: string,
): Promise<RawCredential | null> {
  let credential: RawCredential | null;
  try {
    credential = await source.read();
  } catch (error) {
    console.error(
      `[AccountManager] readCredentialForAccount failed for ${clientId}:${accountId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
  if (!credential) return null;
  return credentialBelongsToAccount(source, account, credential) ? credential : null;
}

/**
 * Builds the stable diagnostic prefix for one credential-preparation attempt.
 * @param clientId - Stable client identifier for diagnostics
 * @param accountId - Stable account identifier for diagnostics
 * @returns Prefix shared by all log lines in the attempt
 */
function buildPrepareCredentialLogPrefix(clientId: string, accountId: string): string {
  return `[AccountManager] ${new Date().toISOString()} prepareCredential ${clientId}:${accountId}`;
}

/**
 * Resolves the freshest safe credential for a stored account, then runs the source-owned
 * refresh flow when available.
 * @param source - Credential source that owns the native store
 * @param account - Stored account being prepared
 * @param clientId - Stable client identifier for diagnostics
 * @param accountId - Stable account identifier for diagnostics
 * @param refreshOptions - Optional refresh behavior overrides passed to the source
 * @returns Prepared credential outcome for the caller's lifecycle policy
 */
export async function prepareStoredAccountCredential(
  source: ICredentialSource,
  account: StoredAccount,
  clientId: string,
  accountId: string,
  refreshOptions?: CredentialRefreshOptions,
): Promise<PreparedAccountCredentialResult> {
  const nativeCredential = await readVerifiedNativeCredential(source, account, clientId, accountId);
  const credential = nativeCredential ?? account.credential;
  const credentialOrigin = nativeCredential ? 'native' : 'stored';
  const logPrefix = buildPrepareCredentialLogPrefix(clientId, accountId);
  if (typeof source.refreshIfNeeded !== 'function') {
    console.info(`${logPrefix} credential=${credentialOrigin}, no refreshIfNeeded on source`);
    return { status: 'ready', credential, refreshStatus: 'unchanged' };
  }

  console.info(
    `${logPrefix} credential=${credentialOrigin}, calling refreshIfNeeded (force=${refreshOptions?.force ?? false})`,
  );
  const refreshResult = await source.refreshIfNeeded(credential, refreshOptions);
  if (refreshResult.status === 'failed') {
    console.warn(`${logPrefix} refresh failed: ${refreshResult.reason}`);
    return {
      status: 'failed',
      credential,
      reason: refreshResult.reason,
    };
  }
  if (refreshResult.status === 'refreshed') {
    console.info(`${logPrefix} refresh succeeded`);
    return {
      status: 'ready',
      credential: refreshResult.credential,
      refreshStatus: 'refreshed',
    };
  }
  if (refreshResult.status === 'transient') {
    console.warn(`${logPrefix} refresh transient: ${refreshResult.reason}`);
    return {
      status: 'ready',
      credential,
      refreshStatus: 'transient',
      refreshReason: refreshResult.reason,
    };
  }
  // "unchanged" can mean token-still-valid, missing refreshToken, missing
  // expiresAt, or unparseable payload — source-level logs disambiguate.
  console.info(`${logPrefix} refreshIfNeeded returned unchanged`);
  return {
    status: 'ready',
    credential,
    refreshStatus: 'unchanged',
  };
}

/**
 * Build the rollback snapshot that should survive a failed native-store write.
 * @param account - Pre-activation stored-account snapshot.
 * @param credential - Prepared credential chosen for activation.
 * @returns Snapshot preserving pre-activation flags plus the freshest credential state.
 */
export function buildPreparedAccountRollbackSnapshot(account: StoredAccount, credential: RawCredential): StoredAccount {
  return {
    ...account,
    credential,
    fingerprint: credential.fingerprint,
    metadata: mergeSourceAccountMetadata(account.metadata, credential.metadata),
  };
}
