/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
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

  describe('polling — deactivateAll on new detection', () => {
    it('deactivates all existing accounts when a new account is detected', async () => {
      const credA = makeCredential('token-a');
      const credB = makeCredential('token-b');
      const credC = makeCredential('token-c');

      source.setCredential(credA);
      await jest.advanceTimersByTime(1000);
      const accountsAfterA = await store.list('claude-code');
      const accountAId = accountsAfterA[0].id;

      source.setCredential(credB);
      await jest.advanceTimersByTime(1000);

      // Verify baseline: B is active, A is inactive
      const beforeAccounts = await store.list('claude-code');
      expect(beforeAccounts).toHaveLength(2);
      const accountBId = beforeAccounts.find((a) => a.fingerprint === credB.fingerprint)?.id;
      expect(beforeAccounts.find((a) => a.id === accountBId)?.active).toBe(true);
      expect(beforeAccounts.find((a) => a.id === accountAId)?.active).toBe(false);

      // Introduce a completely new account C
      source.setCredential(credC);

      const detected: unknown[] = [];
      const cleanup = MakaioBus.on(AccountManagerSubjects.credentials.detected, (ctx) => {
        detected.push(ctx.payload);
      });

      try {
        await jest.advanceTimersByTime(1000);

        const afterAccounts = await store.list('claude-code');
        expect(afterAccounts).toHaveLength(3);

        // Only C is active — find it by fingerprint since its UUID is unpredictable
        const accountC = afterAccounts.find((a) => a.fingerprint === credC.fingerprint);
        expect(accountC?.active).toBe(true);
        // Both A and B are deactivated
        expect(afterAccounts.find((a) => a.id === accountAId)?.active).toBe(false);
        expect(afterAccounts.find((a) => a.id === accountBId)?.active).toBe(false);

        expect(detected).toHaveLength(1);
      } finally {
        cleanup();
      }
    });
  });
});
