/**
 * Tests for useAccounts hook.
 *
 * Verifies source+account fetching, response mapping, refetch on
 * credentials.* events, and null-bus no-op path.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio-community/account-manager/register';
import type { Account, SourceInfo } from '@makaio-community/account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { useAccounts } from '../use-accounts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Account fixture.
 * @param id - Account identifier.
 * @param active - Whether the account is active.
 * @returns A valid Account object.
 */
function makeAccount(id: string, active = false): Account {
  return {
    id,
    active,
    metadata: {},
    detectedAt: 1_000,
    lastSeenAt: 2_000,
  };
}

/**
 * Builds a minimal SourceInfo fixture.
 * @param clientId - Credential-source identifier.
 * @returns A valid SourceInfo object.
 */
function makeSource(clientId: string): SourceInfo {
  return { clientId, displayName: clientId, available: true };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Wraps the hook under test with a real bus context.
 * @param bus - Bus instance to expose via context.
 * @returns React wrapper component.
 */
function makeBusWrapper(bus: IMakaioBus) {
  return function BusWrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: bus }, children);
  };
}

/**
 * Wraps the hook under test without any bus context.
 * @returns React wrapper component.
 */
function makeNullBusWrapper() {
  return function NullBusWrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: null }, children);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAccounts', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    bus = createBusInstance();
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
  });

  it('fetches sources and accounts on mount', async () => {
    const source1 = makeSource('claude-code');
    const source2 = makeSource('codex');
    const account1 = makeAccount('acc-1', true);
    const account2 = makeAccount('acc-2');

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [source1, source2] });
      }),
    );

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        if (ctx.payload.clientId === 'claude-code') {
          ctx.setResult({ accounts: [account1] });
        } else {
          ctx.setResult({ accounts: [account2] });
        }
      }),
    );

    const { result } = renderHook(() => useAccounts(), {
      wrapper: makeBusWrapper(bus),
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.sources).toHaveLength(2);
    });

    expect(result.current.accountsByClient.get('claude-code')).toEqual([account1]);
    expect(result.current.accountsByClient.get('codex')).toEqual([account2]);
    expect(result.current.error).toBeNull();
  });

  it('refetches when credentials.switched fires', async () => {
    let fetchCount = 0;

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        fetchCount += 1;
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [] });
      }),
    );

    renderHook(() => useAccounts(), { wrapper: makeBusWrapper(bus) });

    await waitFor(() => expect(fetchCount).toBe(1));

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.switched, {
        clientId: 'claude-code',
        from: null,
        to: makeAccount('acc-new', true),
      });
    });

    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
  });

  it('refetches when credentials.refreshed fires', async () => {
    let fetchCount = 0;

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        fetchCount += 1;
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [] });
      }),
    );

    renderHook(() => useAccounts(), { wrapper: makeBusWrapper(bus) });

    await waitFor(() => expect(fetchCount).toBe(1));

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.refreshed, {
        clientId: 'claude-code',
        account: makeAccount('acc-1'),
      });
    });

    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
  });

  it('refetches when credentials.detected fires', async () => {
    let fetchCount = 0;

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        fetchCount += 1;
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [] });
      }),
    );

    renderHook(() => useAccounts(), { wrapper: makeBusWrapper(bus) });

    await waitFor(() => expect(fetchCount).toBe(1));

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.detected, {
        clientId: 'claude-code',
        account: makeAccount('acc-new'),
      });
    });

    await waitFor(() => expect(fetchCount).toBeGreaterThanOrEqual(2));
  });

  it('preserves last successful data when source discovery fails after a successful fetch', async () => {
    let shouldFail = false;

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        if (shouldFail) {
          throw new Error('discovery failed');
        }
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [makeAccount('acc-1', true)] });
      }),
    );

    const { result } = renderHook(() => useAccounts(), { wrapper: makeBusWrapper(bus) });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.sources).toHaveLength(1);
      expect(result.current.accountsByClient.get('claude-code')).toHaveLength(1);
    });

    shouldFail = true;

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.detected, {
        clientId: 'claude-code',
        account: makeAccount('acc-new'),
      });
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.sources).toHaveLength(1);
      expect(result.current.accountsByClient.get('claude-code')).toHaveLength(1);
      expect(result.current.error?.message).toContain('discovery failed');
    });
  });

  it('returns no-op shape when bus is absent', () => {
    const { result } = renderHook(() => useAccounts(), {
      wrapper: makeNullBusWrapper(),
    });

    expect(result.current.accountsByClient.size).toBe(0);
    expect(result.current.sources).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(() => result.current.refresh()).not.toThrow();
  });
});
