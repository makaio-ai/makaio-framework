/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
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

  describe('usage tracking — native credential ownership', () => {
    it('falls back to the stored credential when native storage no longer belongs to the active account', async () => {
      const isolatedBus = createBusInstance();
      const isolatedSource = new InMemoryCredentialSource('claude-code', 'Claude Code');
      const isolatedStore = new InMemoryAccountStore();
      const receivedCredentials: RawCredential[] = [];

      isolatedSource.setUsageResolver(async (credential) => {
        receivedCredentials.push(credential);
        return { fetchedAt: Date.now(), windows: [] };
      });
      isolatedSource.setCredentialKeyExtractor((rawToken) => {
        try {
          const parsed = JSON.parse(rawToken) as Record<string, unknown>;
          const rt = parsed['refreshToken'];
          return typeof rt === 'string' ? rt : null;
        } catch {
          return null;
        }
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
        id: '00000000-0000-0000-0000-000000000099',
        fingerprint: 'target-fingerprint',
        label: 'Target',
        metadata: {},
        active: true,
        detectedAt: 1,
        lastSeenAt: 1,
        credential: makeCredential('{"refreshToken":"rt-target","accessToken":"at-target"}'),
      });
      isolatedSource.setCredential(makeCredential('{"refreshToken":"rt-other","accessToken":"at-other"}'));

      try {
        await isolatedService.init();
        receivedCredentials.length = 0;

        await isolatedBus.emit(AccountManagerSubjects.credentials.switched, {
          clientId: 'claude-code',
          from: null,
          to: {
            id: '00000000-0000-0000-0000-000000000099',
            metadata: {},
            active: true,
            detectedAt: 1,
            lastSeenAt: 1,
          },
        });

        expect(receivedCredentials).toHaveLength(1);
        expect(receivedCredentials[0].token).toContain('rt-target');
      } finally {
        await isolatedService.destroy();
      }
    });
  });
});
