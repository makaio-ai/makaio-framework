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

  describe('polling — error handling', () => {
    it('emits error event when source.read throws', async () => {
      source.setAvailable(true);
      source.read = async () => {
        throw new Error('keychain locked');
      };

      const errors: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.error, (ctx) => {
        errors.push(ctx.payload);
      });

      try {
        await vi.advanceTimersByTimeAsync(1000);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          clientId: 'claude-code',
          message: 'keychain locked',
        });
      } finally {
        cleanup();
      }
    });

    it('skips unavailable sources without creating accounts', async () => {
      source.setAvailable(false);
      source.setCredential(makeCredential('some-token'));

      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(0);
    });
  });
});
