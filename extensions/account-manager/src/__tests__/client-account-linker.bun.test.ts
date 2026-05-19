import { describe, expect, it, spyOn } from 'bun:test';
import { createBusInstance } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { AccountManager } from '../account-manager.js';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { StoredAccount } from '../interfaces/account-store.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';

function makeStoredAccount(
  overrides: Partial<StoredAccount> & Pick<StoredAccount, 'id' | 'fingerprint'>,
): StoredAccount {
  const { id, fingerprint, metadata, ...rest } = overrides;
  return {
    id,
    fingerprint,
    label: undefined,
    linkedClientAccountId: undefined,
    metadata: {},
    active: false,
    detectedAt: 1,
    lastSeenAt: 1,
    credential: {
      token: 'token',
      fingerprint,
      metadata: metadata ?? {},
    },
    ...rest,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe('ClientAccountLinker', () => {
  it('links newly detected accounts through client.account.observe', async () => {
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const store = new InMemoryAccountStore();
    const cleanup = bus.on(ClientSubjects.account.observe, (ctx) => {
      expect(ctx.payload.identifiers).toEqual([
        {
          scheme: 'account-org-uuid',
          value: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
          strength: 'strong',
        },
      ]);
      ctx.setResult({ clientAccountId: 'client-account-1' });
    });

    source.setCredential({
      token: 'token-1',
      fingerprint: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      metadata: {
        accountUuid: '11111111-1111-4111-8111-111111111111',
        orgUuid: '22222222-2222-4222-8222-222222222222',
      },
    });

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();

      const [account] = await store.list('claude-code');
      expect(account?.linkedClientAccountId).toBe('client-account-1');
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('backfills linkedClientAccountId for existing accounts during startup', async () => {
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('codex', 'Codex');
    const store = new InMemoryAccountStore();
    const cleanup = bus.on(ClientSubjects.account.observe, (ctx) => {
      expect(ctx.payload.identifiers).toEqual([
        {
          scheme: 'account-id',
          value: 'acct-codex-1',
          strength: 'strong',
        },
      ]);
      ctx.setResult({ clientAccountId: 'client-account-7' });
    });

    await store.upsert(
      'codex',
      makeStoredAccount({
        id: 'local-account-1',
        fingerprint: 'acct-codex-1',
        label: 'Codex Account',
        metadata: {
          authMode: 'chatgpt',
          accountId: 'acct-codex-1',
        },
      }),
    );

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();

      const stored = await store.get('codex', 'local-account-1');
      expect(stored?.linkedClientAccountId).toBe('client-account-7');
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('retries linking when a later accounts.labeled event carries canonical identifiers', async () => {
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const store = new InMemoryAccountStore();

    await store.upsert(
      'claude-code',
      makeStoredAccount({
        id: 'local-account-retry',
        fingerprint: '77777777-7777-4777-8777-777777777777:88888888-8888-4888-8888-888888888888',
        metadata: {
          accountUuid: '77777777-7777-4777-8777-777777777777',
          orgUuid: '88888888-8888-4888-8888-888888888888',
        },
      }),
    );

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();

      await expect(store.get('claude-code', 'local-account-retry')).resolves.toMatchObject({
        linkedClientAccountId: undefined,
      });

      const cleanup = bus.on(ClientSubjects.account.observe, (ctx) => {
        expect(ctx.payload.identifiers).toEqual([
          {
            scheme: 'account-org-uuid',
            value: '77777777-7777-4777-8777-777777777777:88888888-8888-4888-8888-888888888888',
            strength: 'strong',
          },
        ]);
        ctx.setResult({ clientAccountId: 'client-account-retry' });
      });

      try {
        const account = await store.metadataStore.setLabel('claude-code', 'local-account-retry', 'Retry Account');
        expect(account).not.toBeNull();

        await bus.emit(AccountManagerSubjects.accounts.labeled, {
          clientId: 'claude-code',
          account: account!,
        });

        await expect(store.get('claude-code', 'local-account-retry')).resolves.toMatchObject({
          linkedClientAccountId: 'client-account-retry',
        });
      } finally {
        cleanup();
      }
    } finally {
      await service.destroy();
    }
  });

  it('logs linked account persistence failures after clients-core returns a canonical account', async () => {
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('codex', 'Codex');
    const store = new InMemoryAccountStore();
    const cleanup = bus.on(ClientSubjects.account.observe, (ctx) => {
      ctx.setResult({ clientAccountId: 'client-account-persist-failure' });
    });
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => undefined);

    await store.upsert(
      'codex',
      makeStoredAccount({
        id: 'local-account-persist-failure',
        fingerprint: 'acct-codex-persist-failure',
        metadata: {
          authMode: 'chatgpt',
          accountId: 'acct-codex-persist-failure',
        },
      }),
    );
    store.metadataStore.setLinkedClientAccountId = async () => {
      throw new Error('metadata store unavailable');
    };

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[ClientAccountLinker] Failed to persist linked client account for codex:local-account-persist-failure:',
        expect.any(Error),
      );
    } finally {
      consoleSpy.mockRestore();
      cleanup();
      await service.destroy();
    }
  });

  it('emits account.activate for the active account when credentials are detected', async () => {
    // Tests that account.activate is signalled when a credential is detected and
    // clients-core returns a canonical account ID for an active account.
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const store = new InMemoryAccountStore();

    const activateCalls: Array<{ clientId: string; clientAccountId: string }> = [];

    const cleanups = [
      bus.on(ClientSubjects.account.observe, (ctx) => {
        ctx.setResult({ clientAccountId: 'client-account-active-1' });
      }),
      bus.on(ClientSubjects.account.activate, (ctx) => {
        activateCalls.push({ clientId: ctx.payload.clientId, clientAccountId: ctx.payload.clientAccountId });
        ctx.setResult({ accepted: true });
      }),
    ];

    // Set a credential in the source so the polling detects it and emits
    // credentials.detected for a new active account.
    source.setCredential({
      token: 'token-active',
      fingerprint: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
      metadata: {
        accountUuid: '11111111-1111-4111-8111-111111111111',
        orgUuid: '22222222-2222-4222-8222-222222222222',
      },
    });

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();

      // account.activate may be called more than once (detect + syncExistingAccounts
      // both observe the same active account). Verify at least one call arrives with
      // the correct identity — idempotent overwrites at the receiver are fine.
      expect(activateCalls.length).toBeGreaterThanOrEqual(1);
      expect(activateCalls[0]).toMatchObject({
        clientId: 'claude-code',
        clientAccountId: 'client-account-active-1',
      });
    } finally {
      for (const cleanup of cleanups) cleanup();
      await service.destroy();
    }
  });

  it('does not emit account.activate for inactive accounts', async () => {
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('claude-code', 'Claude Code');
    const store = new InMemoryAccountStore();

    const activateCalls: unknown[] = [];

    const cleanups = [
      bus.on(ClientSubjects.account.observe, (ctx) => {
        ctx.setResult({ clientAccountId: 'client-account-inactive' });
      }),
      bus.on(ClientSubjects.account.activate, (ctx) => {
        activateCalls.push(ctx.payload);
        ctx.setResult({ accepted: true });
      }),
    ];

    // Persist an account that is NOT active
    await store.upsert(
      'claude-code',
      makeStoredAccount({
        id: 'inactive-account-id',
        fingerprint: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444',
        active: false,
        metadata: {
          accountUuid: '33333333-3333-4333-8333-333333333333',
          orgUuid: '44444444-4444-4444-8444-444444444444',
        },
      }),
    );

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      pollIntervalMs: 60_000,
      makaioCommand: 'makaio-test',
    });

    try {
      await service.init();

      expect(activateCalls).toHaveLength(0);
    } finally {
      for (const cleanup of cleanups) cleanup();
      await service.destroy();
    }
  });
});
