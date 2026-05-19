/**
 * Tests for {@link CredentialTracker}, focusing on the `bootstrapDedup` phase
 * that runs before the first poll during `start()`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createBusInstance } from '@makaio/bus-core';
import type { StoredAccount } from '../interfaces/account-store.js';
import { CredentialTracker } from '../handlers/credential-tracker.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLIENT_ID = 'test-client';

/**
 * Builds a minimal {@link StoredAccount} for seeding tests.
 *
 * Only `id`, `fingerprint`, `active`, `lastSeenAt`, and `credential.token`
 * need to vary per test — the rest default to safe sentinel values.
 * @param overrides - Fields to override on the default account shape
 * @returns A fully-typed StoredAccount
 */
function makeAccount(overrides: Partial<StoredAccount> & Pick<StoredAccount, 'id' | 'fingerprint'>): StoredAccount {
  return {
    label: undefined,
    metadata: {},
    active: false,
    detectedAt: 1000,
    lastSeenAt: 1000,
    credential: {
      token: 'plain-token',
      fingerprint: overrides.fingerprint,
      metadata: {},
    },
    ...overrides,
  };
}

/**
 * Builds a credential token string carrying an `expiresAt` epoch-ms value.
 *
 * {@link CredentialTracker.pickSurvivor} JSON-parses `credential.token` to
 * extract expiry info, so tests that exercise the expiry-preference branch
 * must use this helper to produce a parseable token.
 * @param expiresAt - Epoch ms for the token expiry
 * @returns A JSON string usable as `RawCredential.token`
 */
function tokenWithExpiry(expiresAt: number): string {
  return JSON.stringify({ expiresAt });
}

// ---------------------------------------------------------------------------
// describe block
// ---------------------------------------------------------------------------

describe('CredentialTracker', () => {
  let source: InMemoryCredentialSource;
  let store: InMemoryAccountStore;
  let tracker: CredentialTracker;

  beforeEach(() => {
    source = new InMemoryCredentialSource(CLIENT_ID, 'Test Client');
    // Source returns null by default so the poll() call inside start() does
    // not create new accounts that would interfere with dedup assertions.
    source.setCredential(null);

    store = new InMemoryAccountStore();

    tracker = new CredentialTracker({
      bus: createBusInstance(),
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      // Simple pass-through — unit tests don't need mutation serialization.
      withClientMutation: (_clientId, action) => action(),
      pollIntervalMs: 60_000,
    });
  });

  afterEach(() => {
    tracker.stop();
  });

  describe('bootstrap dedup', () => {
    it("removes ghost account when fingerprint matches another account's id", async () => {
      // Account A has a stable UUID-style id. Account B is a ghost whose
      // fingerprint equals A's id — the signal 3 / signal 2 cross-reference case.
      const accountA = makeAccount({
        id: 'acct-uuid:org-uuid',
        fingerprint: 'hash-abc',
        lastSeenAt: 1000,
        credential: { token: 'token-old', fingerprint: 'hash-abc', metadata: {} },
      });
      const accountB = makeAccount({
        id: 'random-uuid',
        fingerprint: 'acct-uuid:org-uuid', // b.fingerprint === a.id → duplicate signal
        lastSeenAt: 2000, // more recent → B survives
        credential: { token: 'token-new', fingerprint: 'acct-uuid:org-uuid', metadata: {} },
      });

      await store.upsert(CLIENT_ID, accountA);
      await store.upsert(CLIENT_ID, accountB);

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      expect(accounts).toHaveLength(1);
      // B has the more recent lastSeenAt so it is the survivor.
      expect(accounts[0].id).toBe('random-uuid');
    });

    it('removes duplicate when both accounts share the same fingerprint', async () => {
      const sharedFingerprint = 'shared-fp';
      const accountA = makeAccount({
        id: 'id-a',
        fingerprint: sharedFingerprint,
        lastSeenAt: 1000,
      });
      const accountB = makeAccount({
        id: 'id-b',
        fingerprint: sharedFingerprint,
        lastSeenAt: 2000, // more recent → B survives
      });

      await store.upsert(CLIENT_ID, accountA);
      await store.upsert(CLIENT_ID, accountB);

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe('id-b');
    });

    it('keeps the non-expired account when merging duplicates', async () => {
      const sharedFingerprint = 'shared-fp-expiry';
      const now = Date.now();

      const accountExpired = makeAccount({
        id: 'id-expired',
        fingerprint: sharedFingerprint,
        lastSeenAt: 3000, // more recent but expired → loses
        credential: {
          token: tokenWithExpiry(now - 10_000),
          fingerprint: sharedFingerprint,
          metadata: {},
        },
      });
      const accountValid = makeAccount({
        id: 'id-valid',
        fingerprint: sharedFingerprint,
        lastSeenAt: 1000, // older but non-expired → wins
        credential: {
          token: tokenWithExpiry(now + 60_000),
          fingerprint: sharedFingerprint,
          metadata: {},
        },
      });

      await store.upsert(CLIENT_ID, accountExpired);
      await store.upsert(CLIENT_ID, accountValid);

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe('id-valid');
    });

    it('normalizes multiple active accounts after dedup', async () => {
      // Two accounts with the same fingerprint both marked active.
      // bootstrapDedup collapses them to one survivor (B, more recent lastSeenAt).
      // After dedup there is exactly one account and it must be the sole active one.
      // We give the source a credential matching B so the post-dedup poll()
      // treats it as a known active account (token refresh) rather than
      // deactivating it (which would happen if source returned null).
      const sharedFingerprint = 'shared-fp-active';
      const sharedToken = 'token-active-shared';
      const accountA = makeAccount({
        id: 'id-active-a',
        fingerprint: sharedFingerprint,
        active: true,
        lastSeenAt: 1000,
        credential: { token: sharedToken, fingerprint: sharedFingerprint, metadata: {} },
      });
      const accountB = makeAccount({
        id: 'id-active-b',
        fingerprint: sharedFingerprint,
        active: true,
        lastSeenAt: 2000,
        credential: { token: sharedToken, fingerprint: sharedFingerprint, metadata: {} },
      });

      await store.upsert(CLIENT_ID, accountA);
      await store.upsert(CLIENT_ID, accountB);

      // Provide a credential matching the survivor so the poll() that runs inside
      // start() keeps it active rather than deactivating it on null-read.
      source.setCredential({ token: sharedToken, fingerprint: sharedFingerprint, metadata: {} });

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      // Dedup collapses the two duplicates into one; the survivor is active.
      expect(accounts).toHaveLength(1);
      const activeAccounts = accounts.filter((a) => a.active);
      expect(activeAccounts).toHaveLength(1);
    });

    it('is a no-op for a clean store with distinct accounts', async () => {
      const accountA = makeAccount({
        id: 'id-distinct-a',
        fingerprint: 'fp-distinct-a',
        credential: { token: 'token-distinct-a', fingerprint: 'fp-distinct-a', metadata: {} },
      });
      const accountB = makeAccount({
        id: 'id-distinct-b',
        fingerprint: 'fp-distinct-b',
        credential: { token: 'token-distinct-b', fingerprint: 'fp-distinct-b', metadata: {} },
      });

      await store.upsert(CLIENT_ID, accountA);
      await store.upsert(CLIENT_ID, accountB);

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      expect(accounts).toHaveLength(2);
      const ids = new Set(accounts.map((a) => a.id));
      expect(ids.has('id-distinct-a')).toBe(true);
      expect(ids.has('id-distinct-b')).toBe(true);
    });

    it('removes duplicate when both accounts have the same credential token', async () => {
      // Different fingerprints but identical token — signal 4.
      const sharedToken = 'shared-token-payload';
      const accountA = makeAccount({
        id: 'id-token-a',
        fingerprint: 'fp-token-a',
        lastSeenAt: 1000,
        credential: { token: sharedToken, fingerprint: 'fp-token-a', metadata: {} },
      });
      const accountB = makeAccount({
        id: 'id-token-b',
        fingerprint: 'fp-token-b',
        lastSeenAt: 2000, // more recent → B survives
        credential: { token: sharedToken, fingerprint: 'fp-token-b', metadata: {} },
      });

      await store.upsert(CLIENT_ID, accountA);
      await store.upsert(CLIENT_ID, accountB);

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe('id-token-b');
    });

    it('collapses a connected duplicate cluster even when the final survivor is not directly comparable', async () => {
      const accountA = makeAccount({
        id: 'stable-uuid',
        fingerprint: 'fp-shared',
        lastSeenAt: 1000,
        credential: { token: 'token-a', fingerprint: 'fp-shared', metadata: {} },
      });
      const accountB = makeAccount({
        id: 'ghost-survivor',
        fingerprint: 'stable-uuid',
        lastSeenAt: 3000,
        credential: { token: 'token-b', fingerprint: 'stable-uuid', metadata: {} },
      });
      const accountC = makeAccount({
        id: 'dup-shared',
        fingerprint: 'fp-shared',
        lastSeenAt: 2000,
        credential: { token: 'token-c', fingerprint: 'fp-shared', metadata: {} },
      });

      await store.upsert(CLIENT_ID, accountA);
      await store.upsert(CLIENT_ID, accountB);
      await store.upsert(CLIENT_ID, accountC);

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe('ghost-survivor');
      expect(accounts[0].lastSeenAt).toBe(3000);
    });

    it('merges lastSeenAt from loser into winner', async () => {
      const sharedFingerprint = 'shared-fp-lastseen';
      const now = Date.now();

      // Winner by expiry: accountA has a valid token; accountB is expired.
      // But accountB has the more recent lastSeenAt — it must be merged into A.
      const accountA = makeAccount({
        id: 'id-winner',
        fingerprint: sharedFingerprint,
        lastSeenAt: 1000,
        credential: {
          token: tokenWithExpiry(now + 60_000), // valid → wins
          fingerprint: sharedFingerprint,
          metadata: {},
        },
      });
      const accountB = makeAccount({
        id: 'id-loser',
        fingerprint: sharedFingerprint,
        lastSeenAt: 9999, // more recent — must be merged into winner
        credential: {
          token: tokenWithExpiry(now - 10_000), // expired → loses
          fingerprint: sharedFingerprint,
          metadata: {},
        },
      });

      await store.upsert(CLIENT_ID, accountA);
      await store.upsert(CLIENT_ID, accountB);

      await tracker.start();

      const accounts = await store.list(CLIENT_ID);
      expect(accounts).toHaveLength(1);
      expect(accounts[0].id).toBe('id-winner');
      // Winner's lastSeenAt must have been bumped to the loser's value.
      expect(accounts[0].lastSeenAt).toBe(9999);
    });
  });
});
