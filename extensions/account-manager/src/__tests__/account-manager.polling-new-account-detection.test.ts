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

  describe('polling — new account detection', () => {
    it('marks a new detection as auto-labeled when the source resolves a label inline', async () => {
      const isolatedBus = createBusInstance();
      const isolatedSource = new InMemoryCredentialSource('claude-code', 'Claude Code');
      const isolatedStore = new InMemoryAccountStore();
      isolatedSource.setLabelResolver(async () => 'Business Account');
      const isolatedService = new AccountManager(isolatedBus, {
        sources: [isolatedSource],
        credentialStore: isolatedStore.credentialStore,
        metadataStore: isolatedStore.metadataStore,
        usageSnapshotStore: isolatedStore.usageSnapshotStore,
        pollIntervalMs: 1000,
        makaioCommand: 'makaio-test',
      });
      await isolatedService.init();

      const cred = makeCredential('refresh-token-business');
      isolatedSource.setCredential(cred);

      const detected: unknown[] = [];
      const labeled: unknown[] = [];
      const cleanupDetected = isolatedBus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
        detected.push(ctx.payload);
      });
      const cleanupLabeled = isolatedBus.on(AccountManagerSubjects.accounts.labeled, (ctx) => {
        labeled.push(ctx.payload);
      });

      try {
        await vi.advanceTimersByTimeAsync(1000);

        const accounts = await isolatedStore.list('claude-code');
        expect(accounts).toHaveLength(1);
        expect(accounts[0].label).toBe('Business Account');
        expect(detected).toHaveLength(1);
        expect(detected[0]).toMatchObject({
          clientId: 'claude-code',
          account: expect.objectContaining({ label: 'Business Account' }),
          autoLabeled: true,
        });
        expect(labeled).toHaveLength(1);
      } finally {
        cleanupDetected();
        cleanupLabeled();
        await isolatedService.destroy();
      }
    });

    it('detects a new credential and creates an account', async () => {
      const cred = makeCredential('refresh-token-personal');
      source.setCredential(cred);

      const detected: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
        detected.push(ctx.payload);
      });

      try {
        await vi.advanceTimersByTimeAsync(1000);

        const accounts = await store.list('claude-code');
        expect(accounts).toHaveLength(1);
        expect(accounts[0].id).toMatch(/^[0-9a-f-]+$/);
        expect(accounts[0].fingerprint).toBe(cred.fingerprint);
        expect(accounts[0].active).toBe(true);
        expect(accounts[0].label).toBeUndefined();
        expect(detected).toHaveLength(1);
      } finally {
        cleanup();
      }
    });

    it('strips reserved overlay metadata from newly detected accounts', async () => {
      source.setCredential(
        makeCredential('refresh-token-personal', {
          plan: 'team',
          usageAuthState: 'source-owned',
          usageAuthFingerprint: 'fp-from-source',
          usageAuthMessage: 'should not persist',
          usageAuthDetectedAt: '2026-04-22T00:00:00.000Z',
        }),
      );

      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
      expect(accounts[0]?.metadata).toEqual({ plan: 'team' });
    });

    it('rolls a newly detected account back when publishing credentials.detected fails', async () => {
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

      const errors: unknown[] = [];
      let cleanupError = (): void => {};
      let cleanupFailure = (): void => {};

      try {
        const credA = makeCredential('refresh-token-a');
        isolatedSource.setCredential(credA);
        await vi.advanceTimersByTimeAsync(1000);
        const seededAccounts = await isolatedStore.list('claude-code');
        expect(seededAccounts).toHaveLength(1);
        const accountAId = seededAccounts[0].id;

        cleanupError = isolatedBus.on(AccountManagerSubjects.credentials.error, (ctx) => {
          errors.push(ctx.payload);
        });
        cleanupFailure = isolatedBus.on(AccountManagerSubjects.credentials.detected, () => {
          throw new Error('detected listener failed');
        });

        isolatedSource.setCredential(makeCredential('refresh-token-b'));
        await vi.advanceTimersByTimeAsync(1000);

        const accounts = await isolatedStore.list('claude-code');
        expect(accounts).toHaveLength(1);
        expect(accounts[0].id).toBe(accountAId);
        expect(accounts[0].active).toBe(true);
        expect(await isolatedStore.metadataStore.getLatestTimelineEntry('claude-code', 'detected')).toMatchObject({
          toAccountId: accountAId,
        });
        expect(errors).toContainEqual(
          expect.objectContaining({
            clientId: 'claude-code',
            message: 'detected listener failed',
          }),
        );
      } finally {
        cleanupFailure();
        cleanupError();
        await isolatedService.destroy();
      }
    });

    it('does not re-detect the same fingerprint on subsequent polls', async () => {
      const cred = makeCredential('refresh-token-a');
      source.setCredential(cred);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);

      const accounts = await store.list('claude-code');
      expect(accounts).toHaveLength(1);
    });
  });
});
