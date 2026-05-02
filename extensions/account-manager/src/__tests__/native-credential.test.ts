import { describe, expect, it } from 'vitest';
import type { ICredentialSource, RawCredential } from '../interfaces/credential-source.js';
import type { StoredAccount } from '../interfaces/account-store.js';
import { credentialBelongsToAccount } from '../native-credential.js';

/**
 * Builds a raw credential fixture.
 * @param token - Credential token payload.
 * @param fingerprint - Credential fingerprint.
 * @returns Raw credential fixture.
 */
function makeCredential(token: string, fingerprint: string): RawCredential {
  return { token, fingerprint, metadata: {} };
}

/**
 * Builds a stored account fixture.
 * @param credential - Stored credential.
 * @param fingerprint - Persisted account fingerprint.
 * @returns Stored account fixture.
 */
function makeStoredAccount(credential: RawCredential, fingerprint: string): StoredAccount {
  return {
    id: 'account-1',
    fingerprint,
    credential,
    metadata: {},
    active: false,
    detectedAt: 1,
    lastSeenAt: 1,
  };
}

/**
 * Creates a source whose credential key is the JSON `account_id` field.
 * @param mismatchPolicy - Optional source-owned mismatch policy.
 * @returns Credential source fixture.
 */
function makeAccountIdSource(
  mismatchPolicy?: ICredentialSource['allowsCredentialKeyFingerprintMismatch'],
): ICredentialSource {
  return {
    clientId: 'test-client',
    displayName: 'Test Client',
    async isAvailable() {
      return true;
    },
    async read() {
      return null;
    },
    async write(credential: RawCredential) {
      void credential;
    },
    extractCredentialKey(rawToken: string) {
      const parsed = JSON.parse(rawToken) as Record<string, unknown>;
      const accountId = parsed['account_id'];
      return typeof accountId === 'string' ? accountId : null;
    },
    ...(mismatchPolicy ? { allowsCredentialKeyFingerprintMismatch: mismatchPolicy } : undefined),
  };
}

describe('credentialBelongsToAccount', () => {
  it('rejects a native credential match when the stored token key disagrees with a strict stored fingerprint', () => {
    const source = makeAccountIdSource();
    const account = makeStoredAccount(makeCredential(JSON.stringify({ account_id: 'bob' }), 'alice'), 'alice');
    const nativeCredential = makeCredential(JSON.stringify({ account_id: 'bob' }), 'bob');

    expect(credentialBelongsToAccount(source, account, nativeCredential)).toBe(false);
  });

  it('allows a source-owned fingerprint/key mismatch only when the source policy accepts it', () => {
    const source = makeAccountIdSource(
      ({ accountFingerprint, storedCredentialKey, incomingFingerprint, incomingCredentialKey }) =>
        accountFingerprint.includes(':') &&
        storedCredentialKey === incomingCredentialKey &&
        (incomingFingerprint === accountFingerprint || incomingFingerprint === storedCredentialKey),
    );
    const account = makeStoredAccount(
      makeCredential(JSON.stringify({ account_id: 'hash-a' }), 'acct-a:org-a'),
      'acct-a:org-a',
    );
    const nativeCredential = makeCredential(JSON.stringify({ account_id: 'hash-a' }), 'hash-a');

    expect(credentialBelongsToAccount(source, account, nativeCredential)).toBe(true);
  });
});
