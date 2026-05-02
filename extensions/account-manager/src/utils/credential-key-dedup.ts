import type { RawCredential } from '../interfaces/credential-source.js';
import type { StoredAccount } from '../interfaces/account-store.js';
import type { CredentialSourceWithOptionalLabel } from '../handlers/credential-tracker-types.js';

/**
 * Searches existing stored accounts for one whose credential key matches the
 * incoming credential's key, using the source's `extractCredentialKey` method.
 *
 * Returns `null` when the source does not implement `extractCredentialKey`,
 * when the incoming token produces no key, or when no stored account matches.
 *
 * **Corruption guard:** a key extracted from the stored credential is trusted
 * only when it agrees with the account's persisted fingerprint, unless the
 * source explicitly owns that fingerprint/key mismatch as a real format
 * transition via `allowsCredentialKeyFingerprintMismatch`. This prevents a
 * stored token overwritten by another identity from proving ownership of the
 * original account.
 *
 * The guard is also intentionally bypassed for accounts with an empty
 * fingerprint (legacy bootstrap records written before the fingerprint field
 * existed).
 * @param source - The credential source being polled
 * @param accounts - All currently stored accounts for this client
 * @param current - The incoming credential whose key to match against
 * @returns The first stored account with a matching credential key, or null
 */
export function findAccountByCredentialKey(
  source: CredentialSourceWithOptionalLabel,
  accounts: StoredAccount[],
  current: RawCredential,
): StoredAccount | null {
  if (typeof source.extractCredentialKey !== 'function') return null;
  const incomingKey = source.extractCredentialKey(current.token);
  if (!incomingKey) return null;
  for (const account of accounts) {
    const storedKey = source.extractCredentialKey(account.credential.token);
    if (storedKey && storedKey === incomingKey) {
      const hasStoredFingerprint = account.fingerprint.length > 0;
      const keyFingerprintMismatch = hasStoredFingerprint && storedKey !== account.fingerprint;
      const mismatchAllowed =
        keyFingerprintMismatch &&
        source.allowsCredentialKeyFingerprintMismatch?.({
          accountFingerprint: account.fingerprint,
          storedCredentialKey: storedKey,
          incomingFingerprint: current.fingerprint,
          incomingCredentialKey: incomingKey,
        }) === true;
      if (keyFingerprintMismatch && !mismatchAllowed) {
        continue;
      }
      return account;
    }
  }
  return null;
}
