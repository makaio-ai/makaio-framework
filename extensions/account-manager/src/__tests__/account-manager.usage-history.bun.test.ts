/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import { RequestError, createBusInstance } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import { AccountManager } from '../account-manager.js';
import { InMemoryCredentialSource } from './testing/in-memory-source.js';
import { InMemoryAccountStore } from './testing/in-memory-store.js';
import { MAX_USAGE_HISTORY_RANGE_MS } from '../bus/schemas.js';

describe('AccountManager — usage.history handler', () => {
  const HISTORY_TEST_FROM = Date.UTC(2026, 3, 15, 0, 0, 0);
  const HISTORY_TEST_TO = Date.UTC(2026, 3, 15, 23, 59, 59);

  let historyBus: ReturnType<typeof createBusInstance>;
  let historyService: AccountManager | undefined;
  let historyStore: InMemoryAccountStore;

  beforeEach(async () => {
    jest.useFakeTimers();
    historyBus = createBusInstance();
    const historySource = new InMemoryCredentialSource('claude-code', 'Claude Code');
    historyStore = new InMemoryAccountStore();

    historyService = new AccountManager(historyBus, {
      sources: [historySource],
      credentialStore: historyStore.credentialStore,
      metadataStore: historyStore.metadataStore,
      usageSnapshotStore: historyStore.usageSnapshotStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await historyService.init();
  });

  afterEach(async () => {
    if (historyService) {
      await historyService.destroy();
    }
    jest.useRealTimers();
  });

  it('returns an empty entries array when no data has been written', async () => {
    const result = await historyBus.request(AccountManagerSubjects.usage.history, {
      clientId: 'claude-code',
      accountId: 'acc-no-data',
      from: HISTORY_TEST_FROM,
      to: HISTORY_TEST_TO,
    });

    expect(result.entries).toEqual([]);
  });

  it('returns entries written for the requested clientId/accountId range', async () => {
    const clientId = 'claude-code';
    const accountId = 'acc-test-001';
    const ts1 = Date.UTC(2026, 3, 15, 10, 0, 0);
    const ts2 = Date.UTC(2026, 3, 15, 11, 0, 0);
    await historyStore.usageSnapshotStore.append(clientId, accountId, {
      ts: ts2,
      windowId: '5h',
      utilization: 40,
      resetsAt: ts2 + 1000,
      blocked: false,
    });
    await historyStore.usageSnapshotStore.append(clientId, accountId, {
      ts: ts1,
      windowId: '5h',
      utilization: 30,
      resetsAt: ts1 + 1000,
      blocked: false,
    });
    await historyStore.usageSnapshotStore.append(clientId, 'acc-other', {
      ts: ts1,
      windowId: '5h',
      utilization: 99,
      resetsAt: ts1 + 1000,
      blocked: false,
    });

    const result = await historyBus.request(AccountManagerSubjects.usage.history, {
      clientId,
      accountId,
      from: HISTORY_TEST_FROM,
      to: HISTORY_TEST_TO,
    });

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].ts).toBe(ts1);
    expect(result.entries[1].ts).toBe(ts2);
  });

  it('rejects empty clientId/accountId at the request contract', async () => {
    await expect(
      historyBus.request(AccountManagerSubjects.usage.history, {
        clientId: '',
        accountId: 'acc-test-003',
        from: HISTORY_TEST_FROM,
        to: HISTORY_TEST_TO,
      }),
    ).rejects.toBeInstanceOf(RequestError);

    await expect(
      historyBus.request(AccountManagerSubjects.usage.history, {
        clientId: 'claude-code',
        accountId: '',
        from: HISTORY_TEST_FROM,
        to: HISTORY_TEST_TO,
      }),
    ).rejects.toBeInstanceOf(RequestError);
  });

  it('rejects history ranges longer than 31 days at the request contract', async () => {
    await expect(
      historyBus.request(AccountManagerSubjects.usage.history, {
        clientId: 'claude-code',
        accountId: 'acc-test-003',
        from: HISTORY_TEST_FROM,
        to: HISTORY_TEST_FROM + MAX_USAGE_HISTORY_RANGE_MS + 1,
      }),
    ).rejects.toBeInstanceOf(RequestError);
  });

  it('filters by windowId when provided in the request', async () => {
    const clientId = 'claude-code';
    const accountId = 'acc-test-002';
    const ts = Date.UTC(2026, 3, 15, 10, 0, 0);
    await historyStore.usageSnapshotStore.append(clientId, accountId, {
      ts,
      windowId: '5h',
      utilization: 50,
      resetsAt: ts + 1000,
      blocked: false,
    });
    await historyStore.usageSnapshotStore.append(clientId, accountId, {
      ts: ts + 1000,
      windowId: '7d',
      utilization: 60,
      resetsAt: ts + 2000,
      blocked: false,
    });

    const result = await historyBus.request(AccountManagerSubjects.usage.history, {
      clientId,
      accountId,
      windowId: '5h',
      from: HISTORY_TEST_FROM,
      to: HISTORY_TEST_TO,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].windowId).toBe('5h');
  });

  it('returns empty entries when reader is absent (no reader in options)', async () => {
    // Create a separate service instance without a reader.
    const noReaderBus = createBusInstance();
    const noReaderStore = new InMemoryAccountStore();
    const noReaderService = new AccountManager(noReaderBus, {
      sources: [new InMemoryCredentialSource('claude-code', 'Claude Code')],
      credentialStore: noReaderStore.credentialStore,
      metadataStore: noReaderStore.metadataStore,
      pollIntervalMs: 1000,
      makaioCommand: 'makaio-test',
    });
    await noReaderService.init();

    try {
      const result = await noReaderBus.request(AccountManagerSubjects.usage.history, {
        clientId: 'claude-code',
        accountId: 'acc-no-reader',
        from: HISTORY_TEST_FROM,
        to: HISTORY_TEST_TO,
      });

      expect(result.entries).toEqual([]);
    } finally {
      await noReaderService.destroy();
    }
  });
});
