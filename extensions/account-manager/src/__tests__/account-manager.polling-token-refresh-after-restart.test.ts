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

  describe('polling — token refresh after restart', () => {
    it('emits accountRefreshed when the active account is seen again after service restart', async () => {
      // Detect the account on the first service run
      const cred = makeCredential('refresh-token-personal');
      source.setCredential(cred);
      await vi.advanceTimersByTimeAsync(1000);

      // Restart the service — lastSeen map is wiped, but store still has the account
      await service.destroy();
      service = new AccountManager(MakaioBus, {
        sources: [source],
        credentialStore: store.credentialStore,
        metadataStore: store.metadataStore,
        usageSnapshotStore: store.usageSnapshotStore,
        pollIntervalMs: 1000,
        makaioCommand: 'makaio-test',
      });

      // Register listener BEFORE init — the startup poll fires during init
      // and will emit accountRefreshed for the known active account.
      const refreshed: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.refreshed, (ctx) => {
        refreshed.push(ctx.payload);
      });

      try {
        await service.init();
        expect(refreshed).toHaveLength(1);
      } finally {
        cleanup();
      }
    });
  });
});
