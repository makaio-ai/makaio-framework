import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus, createBusInstance } from '@makaio/bus-core';
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

  describe('usage tracking — refresh-before-fetch', () => {
    it('refreshes an inactive account for usage without writing native storage', async () => {
      const isolatedBus = createBusInstance();
      const isolatedSource = new InMemoryCredentialSource('claude-code', 'Claude Code');
      const isolatedStore = new InMemoryAccountStore();
      const accountId = '00000000-0000-0000-0000-000000000199';
      const stored = makeCredential('{"refreshToken":"rt-old","accessToken":"at-old"}');
      const refreshed = makeCredential('{"refreshToken":"rt-new","accessToken":"at-new"}');
      const receivedCredentials: RawCredential[] = [];
      let resolveUsageSeen!: () => void;
      const usageSeen = new Promise<void>((resolve) => {
        resolveUsageSeen = resolve;
      });

      isolatedSource.setCredential(null);
      isolatedSource.setRefreshHandler(async () => ({ status: 'refreshed', credential: refreshed }));
      isolatedSource.setUsageResolver(async (credential) => {
        receivedCredentials.push(credential);
        resolveUsageSeen();
        return { fetchedAt: Date.now(), windows: [] };
      });

      const isolatedService = new AccountManager(isolatedBus, {
        sources: [isolatedSource],
        credentialStore: isolatedStore.credentialStore,
        metadataStore: isolatedStore.metadataStore,
        usageSnapshotStore: isolatedStore.usageSnapshotStore,
        pollIntervalMs: 1000,
        usagePollIntervalMs: 0,
        makaioCommand: 'makaio-test',
      });

      await isolatedStore.upsert('claude-code', {
        id: accountId,
        fingerprint: 'stable-account-fingerprint',
        label: 'Inactive',
        metadata: {},
        active: false,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: stored,
      });

      try {
        await isolatedService.init();

        const result = await isolatedBus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'claude-code',
          accountId,
        });
        expect(result.refreshed).toBe(1);
        await usageSeen;

        expect(receivedCredentials).toHaveLength(1);
        expect(receivedCredentials[0].token).toBe(refreshed.token);
        expect(receivedCredentials[0].fingerprint).toBe('stable-account-fingerprint');
        expect(isolatedSource.getLastWritten()).toBeUndefined();

        const updatedAccount = await isolatedStore.get('claude-code', accountId);
        expect(updatedAccount?.credential.token).toBe(refreshed.token);
        expect(updatedAccount?.credential.fingerprint).toBe('stable-account-fingerprint');
        expect(updatedAccount?.fingerprint).toBe('stable-account-fingerprint');
      } finally {
        await isolatedService.destroy();
      }
    });
  });
});
