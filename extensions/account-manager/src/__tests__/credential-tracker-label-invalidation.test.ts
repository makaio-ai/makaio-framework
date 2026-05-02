import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { RawCredential } from '../interfaces/credential-source.js';
import { AccountManager } from '../account-manager.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

/**
 * Creates a test credential with explicit or computed fingerprint.
 * @param token - Token string
 * @param meta - Optional metadata
 * @param fingerprint - Optional override fingerprint; defaults to computeFingerprint(token)
 * @returns A RawCredential ready for use
 */
function makeCredential(token: string, meta: Record<string, unknown> = {}, fingerprint?: string): RawCredential {
  return {
    token,
    fingerprint: fingerprint ?? computeFingerprint(token),
    metadata: meta,
  };
}

describe('AccountManager — label invalidation on identity change', () => {
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

  describe('handleCredentialRefresh', () => {
    // These tests assert the label-cleared state, not the final relabeled state.
    // LabelResolver has no source for this client at construction time (the
    // InMemoryCredentialSource's resolveLabel is installed after AccountManager
    // construction, so buildLabelSources() yields an empty map).  The label
    // stays cleared, which is the correct intermediate state to verify.
    it('clears label when identity-bearing fields change on token refresh', async () => {
      // Use a fixed fingerprint so the credential tracker recognises the same account
      // even when the token string changes (same fingerprint = same account = refresh path).
      const credV1: RawCredential = {
        token: 'token-v1',
        fingerprint: 'account-a',
        metadata: { email: 'alice@x.com' },
      };
      source.setLabelResolver(async () => 'Alice');
      source.setCredential(credV1);
      await vi.advanceTimersByTimeAsync(1000);

      // Verify account was stored with label
      const accountsAfterV1 = await store.list('claude-code');
      expect(accountsAfterV1).toHaveLength(1);
      expect(accountsAfterV1[0].label).toBe('Alice');

      // Now refresh: same fingerprint, but email changed → identity changed
      const credV2: RawCredential = {
        token: 'token-v2',
        fingerprint: 'account-a',
        metadata: { email: 'bob@y.com' },
      };
      source.setCredential(credV2);
      await vi.advanceTimersByTimeAsync(1000);

      const accountsAfterV2 = await store.list('claude-code');
      expect(accountsAfterV2).toHaveLength(1);
      // Label must be cleared because identity fields changed
      expect(accountsAfterV2[0].label).toBeUndefined();
    });

    it('preserves label when identity-bearing fields do not change on token refresh', async () => {
      const credV1: RawCredential = {
        token: 'token-v1',
        fingerprint: 'account-a',
        metadata: { email: 'alice@x.com' },
      };
      source.setLabelResolver(async () => 'Alice');
      source.setCredential(credV1);
      await vi.advanceTimersByTimeAsync(1000);

      const accountsAfterV1 = await store.list('claude-code');
      expect(accountsAfterV1[0].label).toBe('Alice');

      // Refresh: same fingerprint, same email → no identity change
      const credV2: RawCredential = {
        token: 'token-v2',
        fingerprint: 'account-a',
        metadata: { email: 'alice@x.com' },
      };
      source.setCredential(credV2);
      await vi.advanceTimersByTimeAsync(1000);

      const accountsAfterV2 = await store.list('claude-code');
      expect(accountsAfterV2).toHaveLength(1);
      // Label must be preserved — same identity
      expect(accountsAfterV2[0].label).toBe('Alice');
    });
  });

  describe('handleKnownAccountSwitch', () => {
    it('clears label when identity-bearing fields change on switch back', async () => {
      // Detect account A with email alice
      const credA = makeCredential('token-a', { email: 'alice@x.com' });
      source.setLabelResolver(async () => 'Alice');
      source.setCredential(credA);
      await vi.advanceTimersByTimeAsync(1000);

      const accountsAfterA = await store.list('claude-code');
      const accountAId = accountsAfterA[0].id;
      expect(accountsAfterA[0].label).toBe('Alice');

      // Detect account B (makes A inactive)
      const credB = makeCredential('token-b', { email: 'bob@y.com' });
      source.setCredential(credB);
      await vi.advanceTimersByTimeAsync(1000);

      // Switch back to A but now with different email → identity changed
      const credAModified = makeCredential('token-a', { email: 'changed@x.com' });
      // credAModified has same fingerprint as credA since same token
      source.setCredential(credAModified);
      await vi.advanceTimersByTimeAsync(1000);

      const accountsAfterSwitch = await store.list('claude-code');
      const accountA = accountsAfterSwitch.find((a) => a.id === accountAId);
      expect(accountA).toBeDefined();
      expect(accountA!.active).toBe(true);
      // Label must be cleared because identity fields changed
      expect(accountA!.label).toBeUndefined();
    });

    it('preserves label when identity-bearing fields do not change on switch back', async () => {
      // Detect account A with email alice
      const credA = makeCredential('token-a', { email: 'alice@x.com' });
      source.setLabelResolver(async () => 'Alice');
      source.setCredential(credA);
      await vi.advanceTimersByTimeAsync(1000);

      const accountsAfterA = await store.list('claude-code');
      const accountAId = accountsAfterA[0].id;
      expect(accountsAfterA[0].label).toBe('Alice');

      // Detect account B (makes A inactive)
      const credB = makeCredential('token-b', { email: 'bob@y.com' });
      source.setCredential(credB);
      await vi.advanceTimersByTimeAsync(1000);

      // Switch back to A with the same email → no identity change
      const credASame = makeCredential('token-a', { email: 'alice@x.com' });
      source.setCredential(credASame);
      await vi.advanceTimersByTimeAsync(1000);

      const accountsAfterSwitch = await store.list('claude-code');
      const accountA = accountsAfterSwitch.find((a) => a.id === accountAId);
      expect(accountA).toBeDefined();
      expect(accountA!.active).toBe(true);
      // Label must be preserved — same identity
      expect(accountA!.label).toBe('Alice');
    });
  });
});
