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

  describe('polling — known account switch', () => {
    it('detects a switch to a known inactive account', async () => {
      // Detect account A
      const credA = makeCredential('refresh-token-a');
      source.setCredential(credA);
      await jest.advanceTimersByTime(1000);

      // Capture account A's stable UUID before it becomes inactive
      const accountsAfterA = await store.list('claude-code');
      const accountAId = accountsAfterA[0].id;

      // Detect account B (makes B active, A inactive)
      const credB = makeCredential('refresh-token-b');
      source.setCredential(credB);
      await jest.advanceTimersByTime(1000);

      // Switch back to A (user ran `claude login` with account A)
      source.setCredential(credA);

      const switched: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.switched, (ctx) => {
        switched.push(ctx.payload);
      });

      try {
        await jest.advanceTimersByTime(1000);

        const accounts = await store.list('claude-code');
        const active = accounts.find((a) => a.active);
        expect(active?.id).toBe(accountAId);
        expect(switched).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('rolls the active account back when publishing credentials.switched fails', async () => {
      const isolatedBus = createBusInstance();
      const isolatedSource = new InMemoryCredentialSource('claude-code', 'Claude Code');
      const isolatedStore = new InMemoryAccountStore();
      const isolatedService = new AccountManager(isolatedBus, {
        sources: [isolatedSource],
        credentialStore: isolatedStore.credentialStore,
        metadataStore: isolatedStore.metadataStore,
        usageSnapshotStore: isolatedStore.usageSnapshotStore,
        pollIntervalMs: 1000,
        makaioCommand: 'makaio-test',
      });
      await isolatedService.init();

      const credA = makeCredential('refresh-token-a');
      const credB = makeCredential('refresh-token-b');
      isolatedSource.setCredential(credA);
      await jest.advanceTimersByTime(1000);
      const [{ id: accountAId }] = await isolatedStore.list('claude-code');

      isolatedSource.setCredential(credB);
      await jest.advanceTimersByTime(1000);
      const accountsAfterB = await isolatedStore.list('claude-code');
      const accountBId = accountsAfterB.find((account) => account.active)?.id;
      expect(accountBId).toBeDefined();

      const errors: unknown[] = [];
      const cleanupError = isolatedBus.on(AccountManagerSubjects.credentials.error, (ctx) => {
        errors.push(ctx.payload);
      });
      const cleanupFailure = isolatedBus.on(AccountManagerSubjects.credentials.switched, () => {
        throw new Error('switch listener failed');
      });

      try {
        isolatedSource.setCredential(credA);
        await jest.advanceTimersByTime(1000);

        const accounts = await isolatedStore.list('claude-code');
        expect(accounts.find((account) => account.active)?.id).toBe(accountBId);
        expect(accounts.find((account) => account.id === accountAId)?.active).toBe(false);
        expect(await isolatedStore.metadataStore.getLatestTimelineEntry('claude-code', 'switch')).toBeNull();
        expect(errors).toContainEqual(
          expect.objectContaining({
            clientId: 'claude-code',
            message: 'switch listener failed',
          }),
        );
      } finally {
        cleanupFailure();
        cleanupError();
        await isolatedService.destroy();
      }
    });
  });
});
