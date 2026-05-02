import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MakaioBus } from '@makaio/bus-core';
import { AccountManager } from '../account-manager.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Returns the `account_id` field from a JSON token string, or null when the
 * token is not valid JSON or does not contain the field.
 * @param rawToken - Raw credential token to parse
 * @returns The account_id string, or null
 */
function extractAccountId(rawToken: string): string | null {
  try {
    const parsed = JSON.parse(rawToken) as Record<string, unknown>;
    const id = parsed['account_id'];
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

describe('CredentialTracker.findByCredentialKey', () => {
  let source: InMemoryCredentialSource;
  let store: InMemoryAccountStore;
  let service: AccountManager;

  beforeEach(async () => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
  });

  describe('genuine credential key match (non-corrupted)', () => {
    it('reconciles an existing account when the fingerprint format changes but the credential key matches', async () => {
      source.setCredentialKeyExtractor(extractAccountId);
      source.setCredentialKeyFingerprintMismatchPolicy(
        ({ accountFingerprint, storedCredentialKey, incomingFingerprint, incomingCredentialKey }) =>
          accountFingerprint.includes(':') &&
          storedCredentialKey === incomingCredentialKey &&
          (incomingFingerprint === accountFingerprint || incomingFingerprint === storedCredentialKey),
      );

      // First poll: account detected with token containing account_id="alice".
      // The fingerprint is a UUID-style value (like the ClaudeCode profile-based
      // fingerprint — "accountUuid:orgUuid"). Primary lookup will succeed for
      // the first poll, storing the account.
      source.setCredential({
        token: JSON.stringify({ account_id: 'alice' }),
        fingerprint: 'uuid-abc:org-xyz',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(1000);

      const before = await store.list('claude-code');
      expect(before).toHaveLength(1);
      const stableId = before[0].id;
      expect(before[0].fingerprint).toBe('uuid-abc:org-xyz');

      // Second poll: source falls back to hash-based fingerprinting (profile
      // endpoint unreachable). The fingerprint now equals the credential key
      // produced by extractAccountId — this is the "hash = credential key"
      // scenario where `current.fingerprint === incomingKey`.
      // Primary fingerprint lookup misses ("alice" ≠ "uuid-abc:org-xyz").
      // findByCredentialKey: storedKey="alice" === incomingKey="alice",
      //   storedKey !== account.fingerprint ("alice" ≠ "uuid-abc:org-xyz") but
      //   storedKey === current.fingerprint ("alice" === "alice")  → guard skipped
      //   → MATCH → reconcile.
      source.setCredential({
        token: JSON.stringify({ account_id: 'alice' }),
        fingerprint: 'alice',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(1000);

      const after = await store.list('claude-code');
      // Reconciliation must not create a second account.
      expect(after).toHaveLength(1);
      // Stable UUID is preserved.
      expect(after[0].id).toBe(stableId);
      // Fingerprint advances to the new hash-based value.
      expect(after[0].fingerprint).toBe('alice');
    });
  });

  // Each scenario seeds accounts with slightly different credential/fingerprint
  // configurations inline.  This keeps each test's corruption scenario readable
  // at a glance rather than hiding the setup behind an extraction helper.
  describe('corrupted stored token is rejected as false positive', () => {
    it('skips an account whose stored token key disagrees with its persisted fingerprint', async () => {
      source.setCredentialKeyExtractor(extractAccountId);

      // Directly seed a "pre-corrupted" account into the store:
      //   - metadata fingerprint = "alice"  (what was first detected)
      //   - credential token contains account_id="bob"  (overwritten by a prior
      //     handleCredentialRefresh that wrote the wrong identity's token)
      const corruptedAccountId = randomUUID();
      const now = Date.now();

      await store.metadataStore.upsert('claude-code', {
        id: corruptedAccountId,
        active: false,
        detectedAt: now,
        lastSeenAt: now,
        metadata: {},
      });
      await store.credentialStore.upsert('claude-code', {
        id: corruptedAccountId,
        fingerprint: 'alice',
        credential: {
          token: JSON.stringify({ account_id: 'bob' }),
          fingerprint: 'alice',
          metadata: {},
        },
      });

      // Source now presents a completely new credential whose fingerprint is
      // the same stable identity key it extracts from the token, matching the
      // Codex account_id invariant.
      // Primary fingerprint lookup misses.
      // findByCredentialKey: corruptedAccount.storedKey="bob" === incomingKey="bob"
      //   BUT account.fingerprint="alice" !== storedKey="bob"  → SKIP (guard fires)
      // Result: a new account is created rather than falsely reconciling the
      // corrupted account.
      source.setCredential({
        token: JSON.stringify({ account_id: 'bob' }),
        fingerprint: 'bob',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      // Corrupted account + new account = 2 total. If the guard were absent,
      // the corrupted account would be reconciled and only 1 account exists.
      expect(accounts).toHaveLength(2);

      // The newly detected account must have fingerprint "bob".
      const newAccount = accounts.find((a) => a.fingerprint === 'bob');
      expect(newAccount).toBeDefined();

      // The corrupted account must not have had its fingerprint changed.
      const unchanged = accounts.find((a) => a.id === corruptedAccountId);
      expect(unchanged).toBeDefined();
      expect(unchanged?.fingerprint).toBe('alice');
    });
  });

  describe('stored token key agrees with fingerprint (happy path bootstrap)', () => {
    it('matches when the stored token key equals the stored fingerprint', async () => {
      source.setCredentialKeyExtractor(extractAccountId);

      // Seed an account where fingerprint and extractCredentialKey(token) agree.
      const accountId = randomUUID();
      const now = Date.now();

      await store.metadataStore.upsert('claude-code', {
        id: accountId,
        active: false,
        detectedAt: now,
        lastSeenAt: now,
        metadata: {},
      });
      await store.credentialStore.upsert('claude-code', {
        id: accountId,
        fingerprint: 'alice',
        credential: {
          token: JSON.stringify({ account_id: 'alice' }),
          fingerprint: 'alice',
          metadata: {},
        },
      });

      // Source returns a credential whose fingerprint has drifted to "alice-v2"
      // but whose account_id key is still "alice".
      // Primary lookup misses ("alice-v2" ≠ "alice").
      // findByCredentialKey: storedKey="alice" === incomingKey="alice" AND
      //   account.fingerprint="alice" === storedKey="alice"  → MATCH.
      source.setCredential({
        token: JSON.stringify({ account_id: 'alice' }),
        fingerprint: 'alice-v2',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      // Reconciled — only one account in the store.
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe(accountId);
      expect(accounts[0].fingerprint).toBe('alice-v2');
    });
  });

  describe('empty stored fingerprint (bootstrap edge case)', () => {
    it('matches when the stored fingerprint is empty (guard is bypassed)', async () => {
      source.setCredentialKeyExtractor(extractAccountId);

      // Seed an account with an empty fingerprint — simulates a legacy record
      // written before the fingerprint field was introduced.
      const accountId = randomUUID();
      const now = Date.now();

      await store.metadataStore.upsert('claude-code', {
        id: accountId,
        active: false,
        detectedAt: now,
        lastSeenAt: now,
        metadata: {},
      });
      await store.credentialStore.upsert('claude-code', {
        id: accountId,
        fingerprint: '',
        credential: {
          token: JSON.stringify({ account_id: 'alice' }),
          fingerprint: '',
          metadata: {},
        },
      });

      // Source returns the same token under a new fingerprint.
      // findByCredentialKey: storedKey="alice" === incomingKey="alice",
      //   but account.fingerprint.length === 0  → guard skipped → MATCH.
      source.setCredential({
        token: JSON.stringify({ account_id: 'alice' }),
        fingerprint: 'alice',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      // The bootstrap account is reconciled — no duplicate created.
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe(accountId);
      expect(accounts[0].fingerprint).toBe('alice');
    });
  });
});
