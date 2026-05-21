// @vitest-environment jsdom
import { createBusInstance } from '@makaio/bus-core';
import { AccountManagerSubjects } from '../bus/namespace.js';
import type { Account, AccountUsage, SourceInfo, UsageWindow } from '../bus/schemas.js';
import type { SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { loadUsageForAccounts } from '../tui/load-usage.js';
import { usageKey, type UsageMap } from '../tui/usage-keys.js';
import type { UsageAwaitingResolutionMap } from '../tui/usage-state.js';

/**
 * Creates a deferred promise for race-oriented tests.
 * @returns Deferred promise controls
 */
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Builds a minimal account fixture for the TUI.
 * @param id - Stable account identifier.
 * @param label - Human-readable label.
 * @returns A valid Account object.
 */
function makeAccount(id: string, label: string): Account {
  return {
    id,
    label,
    metadata: {},
    active: true,
    detectedAt: 1_000,
    lastSeenAt: 1_000,
  };
}

/**
 * Builds a single-window usage snapshot for the TUI.
 * @param utilization - Window utilization percentage.
 * @param fetchedAt - Snapshot timestamp.
 * @param resetsAt - Window reset timestamp.
 * @returns A valid AccountUsage snapshot.
 */
function makeUsage(utilization: number, fetchedAt: number, resetsAt: number): AccountUsage {
  const window: UsageWindow = {
    id: '5h',
    label: '5 Hour',
    utilization,
    resetsAt,
    windowSeconds: 18_000,
  };

  return {
    fetchedAt,
    windows: [window],
  };
}

describe('App load sequencing', () => {
  it('does not merge a stale usage bootstrap after a newer reload prunes accounts', async () => {
    const bus = createBusInstance();
    const source: SourceInfo = {
      clientId: 'claude-code',
      displayName: 'Claude Code',
      available: true,
    };
    const accountA = makeAccount('account-a', 'Account A');
    const accountB = makeAccount('account-b', 'Account B');
    const resetsAt = Date.now() + 60 * 60_000;
    const staleUsage = createDeferred<AccountUsage>();

    let accountAUsageCount = 0;
    const usageCleanup = bus.on(AccountManagerSubjects.usage.get, async (ctx) => {
      if (ctx.payload.accountId === accountA.id) {
        accountAUsageCount++;
        if (accountAUsageCount === 1) {
          const usage = await staleUsage.promise;
          ctx.setResult({ usage });
          return;
        }

        ctx.setResult({ usage: makeUsage(20, 2_000, resetsAt) });
        return;
      }

      ctx.setResult({ usage: makeUsage(10, 1_000, resetsAt) });
    });

    let usageByAccount: UsageMap = {};
    const setUsageByAccount = (action: SetStateAction<UsageMap>): void => {
      usageByAccount = typeof action === 'function' ? action(usageByAccount) : action;
    };
    let usageAwaitingResolutionByAccount: UsageAwaitingResolutionMap = {};
    const setUsageAwaitingResolutionByAccount = (action: SetStateAction<UsageAwaitingResolutionMap>): void => {
      usageAwaitingResolutionByAccount =
        typeof action === 'function' ? action(usageAwaitingResolutionByAccount) : action;
    };
    let currentLoadSeq = 1;
    const canCommitLoad = (loadSeq: number, isCurrentRun: () => boolean): boolean =>
      isCurrentRun() && loadSeq === currentLoadSeq;
    const isCurrentRun = (): boolean => true;

    try {
      const staleLoad = loadUsageForAccounts(
        { bus, canCommitLoad, setUsageByAccount, setUsageAwaitingResolutionByAccount },
        1,
        { [source.clientId]: [accountA, accountB] },
        isCurrentRun,
      );

      await vi.waitFor(() => {
        expect(accountAUsageCount).toBe(1);
      });

      currentLoadSeq = 2;
      const freshLoad = loadUsageForAccounts(
        { bus, canCommitLoad, setUsageByAccount, setUsageAwaitingResolutionByAccount },
        2,
        { [source.clientId]: [accountA] },
        isCurrentRun,
      );

      await freshLoad;

      const accountAKey = usageKey(source.clientId, accountA.id);
      expect(usageByAccount[accountAKey]).toMatchObject({
        fetchedAt: 2_000,
        windows: [expect.objectContaining({ utilization: 20 })],
      });

      staleUsage.resolve(makeUsage(80, 3_000, resetsAt));
      await staleLoad;

      expect(usageByAccount[accountAKey]).toMatchObject({
        fetchedAt: 2_000,
        windows: [expect.objectContaining({ utilization: 20 })],
      });
      expect(usageByAccount).not.toHaveProperty(usageKey(source.clientId, accountB.id));
      expect(usageAwaitingResolutionByAccount).toEqual({});
    } finally {
      usageCleanup();
    }
  });
});
