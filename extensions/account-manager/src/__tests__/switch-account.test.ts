import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import { AccountManager } from '../account-manager.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Creates a minimal test credential with a deterministic fingerprint.
 * @param token - Token string to use as the credential payload
 * @returns A RawCredential with a computed fingerprint
 */
function makeCredential(token: string): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: {},
  };
}

describe('switchAccount', () => {
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

  it('writes the target credential to the source', async () => {
    // Detect two accounts so both are known to the store
    const credA = makeCredential('token-a');
    source.setCredential(credA);
    await vi.advanceTimersByTimeAsync(1000);

    const credB = makeCredential('token-b');
    source.setCredential(credB);
    await vi.advanceTimersByTimeAsync(1000);

    // Resolve stable UUID for credA from the store.
    const accounts = await store.list('claude-code');
    const accountA = accounts.find((a) => a.fingerprint === credA.fingerprint);
    expect(accountA).toBeDefined();

    // Switch back to A via bus handler using the stable UUID.
    const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
      clientId: 'claude-code',
      accountId: accountA!.id,
    });

    expect(result.success).toBe(true);

    const lastWritten = source.getLastWritten();
    expect(lastWritten).toBeDefined();
    expect(lastWritten!.fingerprint).toBe(credA.fingerprint);
  });

  it('updates active flags in the store after switching', async () => {
    const credA = makeCredential('token-a');
    source.setCredential(credA);
    await vi.advanceTimersByTimeAsync(1000);

    const credB = makeCredential('token-b');
    source.setCredential(credB);
    await vi.advanceTimersByTimeAsync(1000);

    // Resolve stable UUIDs from the store (accounts are matched by fingerprint).
    let accounts = await store.list('claude-code');
    const accountA = accounts.find((a) => a.fingerprint === credA.fingerprint);
    const accountB = accounts.find((a) => a.fingerprint === credB.fingerprint);
    expect(accountA).toBeDefined();
    expect(accountB).toBeDefined();

    // B is active after second poll
    expect(accounts.find((a) => a.id === accountB!.id)?.active).toBe(true);
    expect(accounts.find((a) => a.id === accountA!.id)?.active).toBe(false);

    await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
      clientId: 'claude-code',
      accountId: accountA!.id,
    });

    accounts = await store.list('claude-code');
    expect(accounts.find((a) => a.id === accountA!.id)?.active).toBe(true);
    expect(accounts.find((a) => a.id === accountB!.id)?.active).toBe(false);
  });

  it('emits accountSwitched with correct from and to accounts', async () => {
    const credA = makeCredential('token-a');
    source.setCredential(credA);
    await vi.advanceTimersByTimeAsync(1000);

    const credB = makeCredential('token-b');
    source.setCredential(credB);
    await vi.advanceTimersByTimeAsync(1000);

    // Resolve stable UUIDs before subscribing to the switched event.
    const accounts = await store.list('claude-code');
    const accountA = accounts.find((a) => a.fingerprint === credA.fingerprint);
    const accountB = accounts.find((a) => a.fingerprint === credB.fingerprint);
    expect(accountA).toBeDefined();
    expect(accountB).toBeDefined();

    const events: unknown[] = [];
    const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.switched, (ctx) => {
      events.push(ctx.payload);
    });

    try {
      const beforeSwitch = Date.now();
      await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
        clientId: 'claude-code',
        accountId: accountA!.id,
      });

      expect(events).toHaveLength(1);
      const event = events[0] as {
        from: { id: string; active: boolean } | null;
        to: { id: string; active: boolean; lastSeenAt: number };
      };
      expect(event.from?.id).toBe(accountB!.id);
      // from is snapshotted before deactivateAll — reflects pre-switch state.
      expect(event.from?.active).toBe(true);
      expect(event.to.id).toBe(accountA!.id);
      expect(event.to.active).toBe(true);
      expect(event.to.lastSeenAt).toBeGreaterThanOrEqual(beforeSwitch);
    } finally {
      cleanup();
    }
  });

  it('prevents next poll from re-triggering detection after programmatic switch', async () => {
    const credA = makeCredential('token-a');
    source.setCredential(credA);
    await vi.advanceTimersByTimeAsync(1000);

    const credB = makeCredential('token-b');
    source.setCredential(credB);
    await vi.advanceTimersByTimeAsync(1000);

    // Resolve stable UUID for credA from the store.
    const accounts = await store.list('claude-code');
    const accountA = accounts.find((a) => a.fingerprint === credA.fingerprint);
    expect(accountA).toBeDefined();

    // Switch to A writes credA to source and updates lastSeen
    await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
      clientId: 'claude-code',
      accountId: accountA!.id,
    });

    // Source now returns credA — poll should see fingerprint == lastSeen and skip
    const detected: unknown[] = [];
    const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
      detected.push(ctx.payload);
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(detected).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('returns error for a non-existent account', async () => {
    const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
      clientId: 'claude-code',
      accountId: 'non-existent-id',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('clears stale active metadata rows that have no matching credential during a switch', async () => {
    const target = makeCredential('token-target');

    await store.metadataStore.upsert('claude-code', {
      id: 'stale-metadata-only',
      label: 'Stale Metadata',
      metadata: { source: 'metadata-only' },
      active: true,
      detectedAt: 1,
      lastSeenAt: 1,
    });
    await store.upsert('claude-code', {
      id: 'target-account',
      fingerprint: target.fingerprint,
      label: 'Target Account',
      metadata: {},
      active: false,
      detectedAt: 2,
      lastSeenAt: 2,
      credential: target,
    });

    const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
      clientId: 'claude-code',
      accountId: 'target-account',
    });

    expect(result.success).toBe(true);

    const metadataAccounts = await store.metadataStore.list('claude-code');
    expect(metadataAccounts.find((account) => account.id === 'stale-metadata-only')?.active).toBe(false);
    expect(metadataAccounts.find((account) => account.id === 'target-account')?.active).toBe(true);
  });

  it('no-ops when switching to the already-active account', async () => {
    const cred = makeCredential('token-a');
    source.setCredential(cred);
    await vi.advanceTimersByTimeAsync(1000);

    // Resolve stable UUID from the store.
    const accounts = await store.list('claude-code');
    const account = accounts.find((a) => a.fingerprint === cred.fingerprint);
    expect(account).toBeDefined();

    const writesBefore = source.getWriteHistory().length;

    const result = await MakaioBus.request(AccountManagerSubjects.credentials.switch, {
      clientId: 'claude-code',
      accountId: account!.id,
    });

    expect(result.success).toBe(true);
    // No write to the source should occur when account is already active
    expect(source.getWriteHistory().length).toBe(writesBefore);
  });
});
