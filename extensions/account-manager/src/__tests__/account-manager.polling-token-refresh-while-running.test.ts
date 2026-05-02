import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  describe('polling — token refresh while running', () => {
    it('refreshes the active account when the fingerprint is stable but the token changed', async () => {
      source.setCredential({
        token: 'token-v1',
        fingerprint: 'stable-account',
        metadata: {},
      });
      await vi.advanceTimersByTimeAsync(1000);

      const refreshed: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.refreshed, (ctx) => {
        refreshed.push(ctx.payload);
      });

      try {
        source.setCredential({
          token: 'token-v2',
          fingerprint: 'stable-account',
          metadata: {},
        });

        await vi.advanceTimersByTimeAsync(1000);

        const accounts = await store.list('claude-code');
        expect(accounts[0].credential.token).toBe('token-v2');
        expect(refreshed).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('persists and emits metadata-only refreshes when the token stays stable', async () => {
      source.setCredential(makeCredential('token-v1', { plan: 'pro', seats: 1 }));
      await vi.advanceTimersByTimeAsync(1000);

      const refreshed: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.refreshed, (ctx) => {
        refreshed.push(ctx.payload);
      });

      try {
        source.setCredential(makeCredential('token-v1', { plan: 'team', seats: 5 }));

        await vi.advanceTimersByTimeAsync(1000);

        const accounts = await store.list('claude-code');
        expect(accounts).toHaveLength(1);
        expect(accounts[0].metadata).toEqual({ plan: 'team', seats: 5 });
        expect(accounts[0].credential.metadata).toEqual({ plan: 'team', seats: 5 });
        expect(refreshed).toHaveLength(1);
        expect(refreshed[0]).toMatchObject({
          clientId: 'claude-code',
          account: expect.objectContaining({
            metadata: { plan: 'team', seats: 5 },
          }),
          reason: 'credential-updated',
        });
      } finally {
        cleanup();
      }
    });
  });
});
