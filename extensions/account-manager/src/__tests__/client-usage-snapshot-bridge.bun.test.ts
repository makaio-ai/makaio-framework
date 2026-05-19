/// <reference types="bun-types" />
import assert from 'node:assert';
import { afterEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { createBusInstance } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { AccountManager } from '../account-manager.js';
import { AccountManagerSubjects } from '../bus/namespace.js';
import { ingestLinkedClientSnapshot } from '../handlers/client-usage-snapshot.js';
import type { RawCredential } from '../interfaces/credential-source.js';
import type { StoredAccount } from '../interfaces/account-store.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { createUsageCacheKey } from '../usage/usage-partitioning.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountMetadataStore, InMemoryAccountStore } from './testing/in-memory-store.js';

afterEach(() => {
  jest.useRealTimers();
  mock.restore();
});

function makeCredential(token: string): RawCredential {
  return {
    token,
    fingerprint: computeFingerprint(token),
    metadata: {},
  };
}

function makeStoredAccount(clientId: string, accountId: string, linkedClientAccountId?: string): StoredAccount {
  const credential = makeCredential(`${clientId}:${accountId}`);
  return {
    id: accountId,
    label: 'Linked Account',
    linkedClientAccountId,
    metadata: {},
    active: true,
    detectedAt: 0,
    lastSeenAt: 0,
    credential,
    fingerprint: credential.fingerprint,
  };
}

describe('client usage snapshot bridge', () => {
  it('bridges normalized client snapshots into usage.updated and usage.get', async () => {
    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('codex', 'Codex');
    const store = new InMemoryAccountStore();
    await store.upsert('codex', makeStoredAccount('codex', 'acc-1', 'client-account-1'));

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      usagePollIntervalMs: 0,
      usageSourceConfigs: new Map([
        [
          'codex',
          {
            activeIntervalMs: 60_000,
            inactiveIntervalMs: 60_000,
          },
        ],
      ]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const updates: Array<unknown> = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    try {
      await bus.emit(ClientSubjects.usage.snapshot, {
        clientAccountId: 'client-account-1',
        clientId: 'codex',
        observedAt: 1_000,
        source: 'hook',
        usage: {
          windows: [
            { key: 'five-hour', label: '5 Hour', usedPercentage: 25, resetsAt: 20_000 },
            { key: 'seven-day', label: '   ', usedPercentage: 10 },
          ],
        },
      });

      expect(updates).toEqual([
        {
          clientId: 'codex',
          accountId: 'acc-1',
          usage: {
            fetchedAt: 1_000,
            lastOkAt: 1_000,
            stale: false,
            windows: [
              {
                id: 'five-hour',
                label: '5 Hour',
                utilization: 25,
                resetsAt: 20_000,
                windowSeconds: 0,
              },
              {
                id: 'seven-day',
                label: 'seven-day',
                utilization: 10,
                resetsAt: 1_000,
                windowSeconds: 0,
              },
            ],
          },
        },
      ]);

      await expect(
        bus.request(AccountManagerSubjects.usage.get, {
          clientId: 'codex',
          accountId: 'acc-1',
        }),
      ).resolves.toEqual({
        usage: {
          fetchedAt: 1_000,
          lastOkAt: 1_000,
          stale: false,
          windows: [
            {
              id: 'five-hour',
              label: '5 Hour',
              utilization: 25,
              resetsAt: 20_000,
              windowSeconds: 0,
            },
            {
              id: 'seven-day',
              label: 'seven-day',
              utilization: 10,
              resetsAt: 1_000,
              windowSeconds: 0,
            },
          ],
        },
      });
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('lets explicit usage.refresh bypass fresh linked client snapshots', async () => {
    const now = 1_000;
    spyOn(Date, 'now').mockImplementation(() => now);

    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('codex', 'Codex');
    const store = new InMemoryAccountStore();
    await store.upsert('codex', makeStoredAccount('codex', 'linked', 'client-account-1'));
    await store.upsert('codex', makeStoredAccount('codex', 'unlinked'));

    const resolveUsage = mock(async () => ({
      fetchedAt: 2_000,
      windows: [],
    }));
    source.setUsageResolver(resolveUsage);

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      usagePollIntervalMs: 0,
      usageSourceConfigs: new Map([
        [
          'codex',
          {
            activeIntervalMs: 60_000,
            inactiveIntervalMs: 60_000,
          },
        ],
      ]),
      makaioCommand: 'makaio-test',
    });
    await service.init();

    try {
      await bus.emit(ClientSubjects.usage.snapshot, {
        clientAccountId: 'client-account-1',
        clientId: 'codex',
        observedAt: 1_000,
        source: 'hook',
        usage: {
          windows: [],
        },
      });

      await expect(
        bus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'codex',
          accountId: 'linked',
        }),
      ).resolves.toEqual({ refreshed: 1 });
      expect(resolveUsage).toHaveBeenCalledTimes(1);

      await expect(
        bus.request(AccountManagerSubjects.usage.refresh, {
          clientId: 'codex',
          accountId: 'unlinked',
        }),
      ).resolves.toEqual({ refreshed: 1 });
      expect(resolveUsage).toHaveBeenCalledTimes(2);
    } finally {
      await service.destroy();
    }
  });

  it('emits pending reset events from fresh linked client snapshots', async () => {
    spyOn(Date, 'now').mockReturnValue(10_000);

    const bus = createBusInstance();
    const source = new InMemoryCredentialSource('codex', 'Codex');
    const store = new InMemoryAccountStore();
    await store.upsert('codex', makeStoredAccount('codex', 'linked', 'client-account-1'));

    const service = new AccountManager(bus, {
      sources: [source],
      credentialStore: store.credentialStore,
      metadataStore: store.metadataStore,
      usageSnapshotStore: store.usageSnapshotStore,
      usagePollIntervalMs: 0,
      makaioCommand: 'makaio-test',
    });
    await service.init();

    const resetEvents: Array<unknown> = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.windowResetAvailable, (ctx) => {
      resetEvents.push(ctx.payload);
    });

    try {
      await bus.emit(ClientSubjects.usage.snapshot, {
        clientAccountId: 'client-account-1',
        clientId: 'codex',
        observedAt: 9_000,
        source: 'hook',
        usage: {
          windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 99, resetsAt: 8_000 }],
        },
      });

      expect(resetEvents).toEqual([
        {
          clientId: 'codex',
          accountId: 'linked',
          windowId: 'five-hour',
          expiredAt: 8_000,
        },
      ]);
      await expect(bus.request(AccountManagerSubjects.usage.getPendingResets, {})).resolves.toEqual({
        pending: [
          {
            clientId: 'codex',
            accountId: 'linked',
            windowId: 'five-hour',
            expiredAt: 8_000,
          },
        ],
      });
    } finally {
      cleanup();
      await service.destroy();
    }
  });

  it('caps linked snapshot freshness when client observedAt is ahead of local time', async () => {
    spyOn(Date, 'now').mockReturnValue(1_000);

    const bus = createBusInstance();
    const metadataStore = new InMemoryAccountMetadataStore();
    await metadataStore.upsert('codex', {
      id: 'linked',
      label: 'Linked Account',
      linkedClientAccountId: 'client-account-1',
      metadata: {},
      active: true,
      detectedAt: 0,
      lastSeenAt: 0,
    });

    const accountGenerations = new Map<string, number>();
    const usageCache = new Map();
    const cacheKeyIndex = new Map<string, { clientId: string; accountId: string }>();
    const linkedClientSnapshotFreshUntil = new Map<string, number>();
    const lastFetchAt = new Map<string, number>();
    const errorCooldownUntil = new Map<string, number>();
    const persistedWindows = new Map();
    const persistenceChains = new Map<string, Promise<void>>();

    await ingestLinkedClientSnapshot({
      bus,
      metadataStore,
      usageSnapshotStore: undefined,
      snapshot: {
        clientAccountId: 'client-account-1',
        clientId: 'codex',
        observedAt: 1_000_000,
        source: 'hook',
        usage: {
          windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 25 }],
        },
      },
      accountGenerations,
      usageCache,
      cacheKeyIndex,
      linkedClientSnapshotFreshUntil,
      lastFetchAt,
      errorCooldownUntil,
      persistedWindows,
      persistenceChains,
      pollIntervalMs: 60_000,
      sourceConfigs: new Map(),
      isCurrentGeneration: (cacheKey, generation) => (accountGenerations.get(cacheKey) ?? 0) === generation,
      isStopped: () => false,
      emitPendingResetsIfFresh: async () => undefined,
    });

    expect(linkedClientSnapshotFreshUntil.get(createUsageCacheKey('codex', 'linked'))).toBe(61_000);
  });

  it('does not mutate usage state after stop wins while linked accounts are still loading', async () => {
    const bus = createBusInstance();
    const metadataStore = new InMemoryAccountMetadataStore();
    await metadataStore.upsert('codex', {
      id: 'linked',
      label: 'Linked Account',
      linkedClientAccountId: 'client-account-1',
      metadata: {},
      active: true,
      detectedAt: 0,
      lastSeenAt: 0,
    });

    let enteredList: (() => void) | undefined;
    let releaseList: (() => void) | undefined;
    const listEntered = new Promise<void>((resolve) => {
      enteredList = resolve;
    });
    const originalListByLinkedClientAccountId = metadataStore.listByLinkedClientAccountId.bind(metadataStore);
    spyOn(metadataStore, 'listByLinkedClientAccountId').mockImplementation(
      async (clientId: string, linkedClientAccountId: string) => {
        enteredList?.();
        await new Promise<void>((resolve) => {
          releaseList = resolve;
        });
        return originalListByLinkedClientAccountId(clientId, linkedClientAccountId);
      },
    );

    const updates: Array<unknown> = [];
    const cleanup = bus.on(AccountManagerSubjects.usage.updated, (ctx) => {
      updates.push(ctx.payload);
    });

    const accountGenerations = new Map<string, number>();
    const usageCache = new Map();
    const cacheKeyIndex = new Map<string, { clientId: string; accountId: string }>();
    const linkedClientSnapshotFreshUntil = new Map<string, number>();
    const lastFetchAt = new Map<string, number>();
    const errorCooldownUntil = new Map<string, number>();
    const persistedWindows = new Map();
    const persistenceChains = new Map<string, Promise<void>>();
    let stopped = false;

    try {
      const pendingIngest = ingestLinkedClientSnapshot({
        bus,
        metadataStore,
        usageSnapshotStore: undefined,
        snapshot: {
          clientAccountId: 'client-account-1',
          clientId: 'codex',
          observedAt: 1_000,
          source: 'hook',
          usage: {
            windows: [{ key: 'five-hour', label: '5 Hour', usedPercentage: 25, resetsAt: 20_000 }],
          },
        },
        accountGenerations,
        usageCache,
        cacheKeyIndex,
        linkedClientSnapshotFreshUntil,
        lastFetchAt,
        errorCooldownUntil,
        persistedWindows,
        persistenceChains,
        pollIntervalMs: 0,
        sourceConfigs: new Map(),
        isCurrentGeneration: (cacheKey, generation) => (accountGenerations.get(cacheKey) ?? 0) === generation,
        isStopped: () => stopped,
        emitPendingResetsIfFresh: async () => undefined,
      });

      await listEntered;
      stopped = true;
      releaseList?.();
      await pendingIngest;

      expect(updates).toEqual([]);
      expect(usageCache.size).toBe(0);
      expect(linkedClientSnapshotFreshUntil.size).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('preserves windows from prior cache that are absent in the incoming statusline snapshot', async () => {
    const bus = createBusInstance();
    const metadataStore = new InMemoryAccountMetadataStore();
    await metadataStore.upsert('claude-code', {
      id: 'acc-1',
      label: 'Test Account',
      linkedClientAccountId: 'client-account-1',
      metadata: {},
      active: true,
      detectedAt: 0,
      lastSeenAt: 0,
    });

    const accountGenerations = new Map<string, number>();
    const usageCache = new Map();
    const cacheKeyIndex = new Map<string, { clientId: string; accountId: string }>();
    const linkedClientSnapshotFreshUntil = new Map<string, number>();
    const lastFetchAt = new Map<string, number>();
    const errorCooldownUntil = new Map<string, number>();
    const persistedWindows = new Map();
    const persistenceChains = new Map<string, Promise<void>>();

    const commonOpts = {
      bus,
      metadataStore,
      usageSnapshotStore: undefined,
      accountGenerations,
      usageCache,
      cacheKeyIndex,
      linkedClientSnapshotFreshUntil,
      lastFetchAt,
      errorCooldownUntil,
      persistedWindows,
      persistenceChains,
      pollIntervalMs: 60_000,
      sourceConfigs: new Map(),
      isCurrentGeneration: (cacheKey: string, generation: number) =>
        (accountGenerations.get(cacheKey) ?? 0) === generation,
      isStopped: () => false,
      emitPendingResetsIfFresh: async () => undefined,
    };

    // First ingest: API poll with 3 windows including seven-day-sonnet
    await ingestLinkedClientSnapshot({
      ...commonOpts,
      snapshot: {
        clientAccountId: 'client-account-1',
        clientId: 'claude-code',
        observedAt: 1_000,
        source: 'api',
        usage: {
          windows: [
            { key: 'five-hour', label: '5 Hour', usedPercentage: 10, resetsAt: 20_000 },
            { key: 'seven-day', label: '7 Day', usedPercentage: 50, resetsAt: 100_000 },
            { key: 'seven-day-sonnet', label: '7 Day Sonnet', usedPercentage: 30, resetsAt: 100_000 },
          ],
        },
      },
    });

    const cacheKey = createUsageCacheKey('claude-code', 'acc-1');
    const afterApi = usageCache.get(cacheKey);
    assert(afterApi, `Expected usageCache entry for ${cacheKey} after API ingest`);
    expect(afterApi.windows).toHaveLength(3);

    // Second ingest: statusline with only 2 windows (no seven-day-sonnet)
    await ingestLinkedClientSnapshot({
      ...commonOpts,
      snapshot: {
        clientAccountId: 'client-account-1',
        clientId: 'claude-code',
        observedAt: 2_000,
        source: 'statusline',
        usage: {
          windows: [
            { key: 'five-hour', label: '5 Hour', usedPercentage: 15, resetsAt: 20_000 },
            { key: 'seven-day', label: '7 Day', usedPercentage: 55, resetsAt: 100_000 },
          ],
        },
      },
    });

    const afterStatusline = usageCache.get(cacheKey);
    assert(afterStatusline, `Expected usageCache entry for ${cacheKey} after statusline ingest`);
    expect(afterStatusline.windows).toHaveLength(3);

    const windowIds = afterStatusline.windows.map((w: { id: string }) => w.id);
    expect(windowIds).toContain('five-hour');
    expect(windowIds).toContain('seven-day');
    expect(windowIds).toContain('seven-day-sonnet');

    // Updated windows should reflect statusline values
    const fiveHour = afterStatusline.windows.find((w: { id: string }) => w.id === 'five-hour');
    assert(fiveHour, 'Expected five-hour window after statusline merge');
    expect(fiveHour.utilization).toBe(15);
    const sevenDay = afterStatusline.windows.find((w: { id: string }) => w.id === 'seven-day');
    assert(sevenDay, 'Expected seven-day window after statusline merge');
    expect(sevenDay.utilization).toBe(55);
    expect(sevenDay.resetsAt).toBe(100_000);

    // Preserved window retains its original values
    const sonnet = afterStatusline.windows.find((w: { id: string }) => w.id === 'seven-day-sonnet');
    assert(sonnet, 'Expected seven-day-sonnet window after statusline merge');
    expect(sonnet.utilization).toBe(30);

    await ingestLinkedClientSnapshot({
      ...commonOpts,
      snapshot: {
        clientAccountId: 'client-account-1',
        clientId: 'claude-code',
        observedAt: 3_000,
        source: 'api',
        usage: {
          windows: [
            { key: 'five-hour', label: '5 Hour', usedPercentage: 20, resetsAt: 40_000 },
            { key: 'seven-day', label: '7 Day', usedPercentage: 60, resetsAt: 120_000 },
          ],
        },
      },
    });

    const afterSecondApi = usageCache.get(cacheKey);
    assert(afterSecondApi, `Expected usageCache entry for ${cacheKey} after second API ingest`);
    expect(afterSecondApi.windows.map((w: { id: string }) => w.id)).toEqual(['five-hour', 'seven-day']);
  });
});
