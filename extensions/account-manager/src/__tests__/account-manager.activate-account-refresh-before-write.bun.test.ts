/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import { AccountManager } from '../account-manager.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Creates a test credential with a deterministic fingerprint derived from the token.
 * @param token - Token string to use as the credential payload
 * @param meta - Optional metadata
 * @returns A RawCredential with a computed fingerprint
 */
function makeCredential(token: string, meta: Record<string, unknown> = {}): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: meta,
  };
}

describe('AccountManager', () => {
  let source: InMemoryCredentialSource;
  let store: InMemoryAccountStore;
  let service: AccountManager;

  beforeEach(async () => {
    jest.useFakeTimers();
    source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    store = new InMemoryAccountStore();
    service = new AccountManager(MakaioBus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
    jest.useRealTimers();
  });

  describe('activateAccount — refresh-before-write', () => {
    const ACCOUNT_ID = '00000000-0000-0000-0000-000000000010';

    /**
     * Seeds the store with a single inactive account and the source with an
     * "other" credential so source.read() returns something different.
     * @param storedCred - The credential stored for the target account
     * @returns The seeded stored account id
     */
    async function seedAccount(storedCred: RawCredential): Promise<string> {
      await store.upsert('claude-code', {
        id: ACCOUNT_ID,
        fingerprint: storedCred.fingerprint,
        label: 'Test',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: storedCred,
      });
      return ACCOUNT_ID;
    }

    it('refreshes before write when refreshIfNeeded returns a new credential', async () => {
      const stored = makeCredential('token-expired');
      const refreshed = makeCredential('token-fresh');
      await seedAccount(stored);

      // source.read() returns null (no different keychain credential) — refresh
      // path exercised directly via refreshIfNeeded.
      source.setCredential(null);
      source.setRefreshHandler(async () => ({ status: 'refreshed', credential: refreshed }));

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      expect(source.getLastWritten()).toEqual(refreshed);
      const active = (await store.list('claude-code')).find((a) => a.active);
      expect(active?.credential).toEqual(refreshed);
      expect(active?.fingerprint).toBe(refreshed.fingerprint);
    });

    it('writes original credential when refreshIfNeeded reports unchanged', async () => {
      const stored = makeCredential('token-still-valid');
      await seedAccount(stored);

      source.setCredential(null);
      source.setRefreshHandler(async () => ({ status: 'unchanged' }));

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      expect(source.getLastWritten()).toEqual(stored);
      const active = (await store.list('claude-code')).find((a) => a.active);
      expect(active?.credential).toEqual(stored);
    });

    it('fails the switch when refreshIfNeeded reports a failed refresh attempt', async () => {
      const stored = makeCredential('token-expired');
      await seedAccount(stored);

      source.setCredential(null);
      source.setRefreshHandler(async () => ({
        status: 'failed',
        reason: 'Claude OAuth refresh failed with HTTP 500 Internal Server Error',
      }));

      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Claude OAuth refresh failed');
      expect(source.getLastWritten()).toBeUndefined();

      // Zombie pruning: the account must be fully removed, not merely deactivated.
      const removedAccount = await store.get('claude-code', ACCOUNT_ID);
      expect(removedAccount).toBeNull();
    });

    it('skips keychain adoption when keychain credential belongs to a different account', async () => {
      const stored = makeCredential('{"refreshToken":"rt-mine","accessToken":"at-1"}');
      const keychainOther = makeCredential('{"refreshToken":"rt-theirs","accessToken":"at-2"}');
      await seedAccount(stored);

      // Keychain holds a different account's credential.
      source.setCredential(keychainOther);

      // Extractor keys on the refreshToken field so the two are distinguishable.
      source.setCredentialKeyExtractor((rawToken) => {
        try {
          const parsed = JSON.parse(rawToken) as Record<string, unknown>;
          const rt = parsed['refreshToken'];
          return typeof rt === 'string' ? rt : null;
        } catch {
          return null;
        }
      });
      // No refresh needed — isolate the keychain adoption check.
      source.setRefreshHandler(async () => ({ status: 'unchanged' }));

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Must write the stored credential, not the keychain one.
      expect(source.getLastWritten()).toEqual(stored);
    });

    it('adopts keychain credential when it belongs to the same account', async () => {
      const stored: RawCredential = {
        token: '{"refreshToken":"rt-mine","accessToken":"at-old"}',
        fingerprint: 'rt-mine',
        metadata: {},
      };
      // Keychain has the same refreshToken but an updated accessToken.
      const keychainNewer: RawCredential = {
        token: '{"refreshToken":"rt-mine","accessToken":"at-new"}',
        fingerprint: 'rt-mine',
        metadata: {},
      };
      await seedAccount(stored);

      source.setCredential(keychainNewer);

      source.setCredentialKeyExtractor((rawToken) => {
        try {
          const parsed = JSON.parse(rawToken) as Record<string, unknown>;
          const rt = parsed['refreshToken'];
          return typeof rt === 'string' ? rt : null;
        } catch {
          return null;
        }
      });

      // Track which credential reaches refreshIfNeeded.
      let receivedByRefresh: RawCredential | null = null;
      source.setRefreshHandler(async (cred) => {
        receivedByRefresh = cred;
        return { status: 'unchanged' }; // no further refresh needed
      });

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Should write the keychain (adopted) credential, not the stale stored one.
      expect(source.getLastWritten()).toEqual(keychainNewer);
      // refreshIfNeeded should have received the adopted credential.
      expect(receivedByRefresh as unknown as RawCredential).toEqual(keychainNewer);
    });

    it('falls through to refreshIfNeeded with stored credential when extractCredentialKey is absent', async () => {
      const stored = makeCredential('token-no-extractor');
      const keychainOther = makeCredential('token-keychain-other');
      await seedAccount(stored);

      // Keychain returns a different token but source has no extractCredentialKey.
      source.setCredential(keychainOther);
      // No setCredentialKeyExtractor call → extractCredentialKey is undefined.

      const refreshed = makeCredential('token-refreshed');
      source.setRefreshHandler(async () => ({ status: 'refreshed', credential: refreshed }));

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Keychain credential must NOT be adopted (no extractor to verify ownership).
      // refreshIfNeeded runs on the stored credential and returns a refreshed one.
      expect(source.getLastWritten()).toEqual(refreshed);
    });

    it('adopts keychain credential when fingerprints match and source has no extractCredentialKey', async () => {
      const stored = makeCredential('token-stored-v1');
      // Keychain has the same fingerprint (same identity) but a different token
      // (e.g. the access token rotated). Simulate by manually crafting a credential
      // with the same fingerprint but a distinct token string.
      const keychainNewer: RawCredential = {
        token: 'token-keychain-v2',
        fingerprint: stored.fingerprint,
        metadata: {},
      };
      await seedAccount(stored);

      // No extractCredentialKey → fingerprint-based ownership path.
      source.setCredential(keychainNewer);
      source.setRefreshHandler(async () => ({ status: 'unchanged' }));

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Keychain credential must be adopted — same fingerprint proves same identity.
      expect(source.getLastWritten()).toEqual(keychainNewer);
      const active = (await store.list('claude-code')).find((a) => a.active);
      expect(active?.credential).toEqual(keychainNewer);
    });

    it('rejects keychain credential when fingerprints differ and source has no extractCredentialKey', async () => {
      const stored = makeCredential('token-stored-mine');
      const keychainOther = makeCredential('token-keychain-theirs');
      await seedAccount(stored);

      // Keychain holds a different account's credential (different fingerprint).
      // No extractCredentialKey → fingerprint-based ownership path.
      source.setCredential(keychainOther);
      source.setRefreshHandler(async () => ({ status: 'unchanged' }));

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Stored credential must be used — fingerprints differ, so keychain
      // credential cannot be proven to belong to the target account.
      expect(source.getLastWritten()).toEqual(stored);
      const active = (await store.list('claude-code')).find((a) => a.active);
      expect(active?.credential).toEqual(stored);
    });

    it('rejects keychain credential when both fingerprints are empty strings', async () => {
      // Both stored and keychain credentials carry an empty fingerprint.
      // The empty-fingerprint guard must prevent adoption even though they
      // technically "match" as empty strings.
      const stored: RawCredential = { token: 'token-empty-fp-stored', fingerprint: '', metadata: {} };
      const keychainEmpty: RawCredential = { token: 'token-empty-fp-keychain', fingerprint: '', metadata: {} };

      await store.upsert('claude-code', {
        id: ACCOUNT_ID,
        fingerprint: stored.fingerprint,
        label: 'Test',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: stored,
      });

      // No extractCredentialKey → fingerprint-based ownership path.
      source.setCredential(keychainEmpty);
      source.setRefreshHandler(async () => ({ status: 'unchanged' }));

      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Must write the stored credential — empty fingerprint is never a valid
      // ownership signal, so the keychain credential must not be adopted.
      expect(source.getLastWritten()).toEqual(stored);
    });

    it('removes zombie account from store when refreshIfNeeded fails', async () => {
      const stored = makeCredential('token-zombie');
      await seedAccount(stored);

      source.setCredential(null);
      source.setRefreshHandler(async () => ({
        status: 'failed',
        reason: 'invalid_grant: refresh token revoked',
      }));

      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Switch must surface the failure.
      expect(result.success).toBe(false);
      expect(result.error).toContain('invalid_grant');

      // Nothing should have been written to native storage.
      expect(source.getLastWritten()).toBeUndefined();

      // The zombie account must be fully removed — not just deactivated.
      const removedAccount = await store.get('claude-code', ACCOUNT_ID);
      expect(removedAccount).toBeNull();

      // The store list must also reflect the removal.
      const remaining = await store.list('claude-code');
      expect(remaining).toHaveLength(0);
    });

    it('does not remove account from store when refreshIfNeeded succeeds', async () => {
      const stored = makeCredential('token-valid');
      const refreshed = makeCredential('token-refreshed-valid');
      await seedAccount(stored);

      source.setCredential(null);
      source.setRefreshHandler(async () => ({ status: 'refreshed', credential: refreshed }));

      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      expect(result.success).toBe(true);

      // Account must still exist in the store.
      const account = await store.get('claude-code', ACCOUNT_ID);
      expect(account).not.toBeNull();
      expect(account?.active).toBe(true);
      expect(account?.credential).toEqual(refreshed);
    });

    it('proceeds with stored credential and does not remove account when refreshIfNeeded is transient', async () => {
      const stored = makeCredential('token-maybe-stale');
      await seedAccount(stored);

      source.setCredential(null);
      source.setRefreshHandler(async () => ({
        status: 'transient',
        reason: 'OAuth token exchange failed with HTTP 500 Internal Server Error',
      }));

      const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: ACCOUNT_ID,
      });

      // Switch must succeed — the transient failure is not terminal.
      expect(result.success).toBe(true);

      // Account must still exist and be active.
      const account = await store.get('claude-code', ACCOUNT_ID);
      expect(account).not.toBeNull();
      expect(account?.active).toBe(true);

      // The stored credential must be written as-is (no refresh applied).
      expect(source.getLastWritten()).toEqual(stored);
    });
  });
});
