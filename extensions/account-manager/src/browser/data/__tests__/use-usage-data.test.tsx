// @vitest-environment jsdom
/**
 * Tests for useUsageData hook.
 *
 * Verifies poll cadence, visibility pause/resume, instant invalidation on bus
 * events, the `refresh()` → `usage.refresh` RPC path, and the null-bus
 * no-op path.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/subjects';
import type { AccountUsage } from '@makaio/extension-account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { flushMicrotasks } from '../../__tests__/test-utils.js';
import { clearUsageCache, useUsageData } from '../use-usage-data.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLIENT_ID = 'claude-code';
const ACCOUNT_ID = 'acc-1';

/**
 * Builds a minimal usage snapshot for test fixtures.
 * @param fetchedAt - Epoch ms for the snapshot timestamp.
 * @returns A valid AccountUsage fixture.
 */
function makeUsage(fetchedAt: number): AccountUsage {
  return {
    fetchedAt,
    windows: [
      {
        id: '5h',
        label: '5 Hour',
        utilization: 50,
        resetsAt: fetchedAt + 3_600_000,
        windowSeconds: 18_000,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Wraps the hook under test with a real bus context.
 * @param bus - Bus instance to expose via context.
 * @returns A React wrapper component.
 */
function makeBusWrapper(bus: IMakaioBus) {
  return function BusWrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: bus }, children);
  };
}

/**
 * Wraps the hook under test without any bus context (null bus path).
 * @returns A React wrapper component.
 */
function makeNullBusWrapper() {
  return function NullBusWrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: null }, children);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useUsageData', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    clearUsageCache();
    bus = createBusInstance();
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    // Ensure fake timers are always restored, even if a test times out before
    // calling vi.useRealTimers() itself.
    vi.useRealTimers();
  });

  it('fetches usage on mount and populates data', async () => {
    const usage = makeUsage(1_000_000);

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        expect(ctx.payload.clientId).toBe(CLIENT_ID);
        expect(ctx.payload.accountId).toBe(ACCOUNT_ID);
        ctx.setResult({ usage });
      }),
    );

    const { result } = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeBusWrapper(bus),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(usage);
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();
    });
  });

  it('supports non-ASCII client and account identifiers', async () => {
    const usage = makeUsage(1_100_000);
    const clientId = 'cláude-code';
    const accountId = '账号-1';

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        expect(ctx.payload.clientId).toBe(clientId);
        expect(ctx.payload.accountId).toBe(accountId);
        ctx.setResult({ usage });
      }),
    );

    const { result } = renderHook(() => useUsageData({ clientId, accountId }), { wrapper: makeBusWrapper(bus) });

    await waitFor(() => {
      expect(result.current.data).toEqual(usage);
      expect(result.current.error).toBeNull();
    });
  });

  it('deduplicates concurrent observers for the same account', async () => {
    let callCount = 0;

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        callCount += 1;
        ctx.setResult({ usage: makeUsage(1_200_000) });
      }),
    );

    const first = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeBusWrapper(bus),
    });
    const second = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeBusWrapper(bus),
    });

    await waitFor(() => {
      expect(first.result.current.data).not.toBeNull();
      expect(second.result.current.data).not.toBeNull();
    });

    expect(callCount).toBe(1);
  });

  it('polls at regular intervals while visible', async () => {
    vi.useFakeTimers();
    let callCount = 0;

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        callCount += 1;
        ctx.setResult({ usage: makeUsage(Date.now()) });
      }),
    );

    renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), { wrapper: makeBusWrapper(bus) });

    // Flush the initial fetchUsage() microtask chain.
    await flushMicrotasks();

    const initialCallCount = callCount;
    expect(initialCallCount).toBeGreaterThanOrEqual(1);

    // Advance the clock by one full poll interval — the setInterval callback
    // fires and triggers a second fetchUsage() call (document is visible).
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // Flush the microtask chain triggered by the poll tick.
    await flushMicrotasks();

    expect(callCount).toBe(initialCallCount + 1);
  });

  it('pauses polling when document is hidden and resumes with immediate fetch on visibility', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const originalVisibilityState = Object.getOwnPropertyDescriptor(document, 'visibilityState');

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        callCount += 1;
        ctx.setResult({ usage: makeUsage(Date.now()) });
      }),
    );

    try {
      renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), { wrapper: makeBusWrapper(bus) });

      // Flush all microtasks so the initial fetchUsage() bus.request chain settles and
      // React applies the resulting state updates. act() drains the React scheduler after
      // the awaited microtask queue empties.
      await flushMicrotasks();

      // Assert directly — waitFor relies on setInterval which is faked.
      expect(callCount).toBeGreaterThanOrEqual(1);
      const countAfterMount = callCount;

      // Hide the document.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });

      // Advance 60 s — the interval fires but should not fetch while hidden.
      // NOTE: we do NOT call vi.runAllTimersAsync() here; that would fire the
      // pTimeout(60 000 ms) guard inside bus.request and abort in-flight RPCs.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      await flushMicrotasks(1);

      expect(callCount).toBe(countAfterMount);

      // Make document visible again and fire the visibilitychange event.
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'visible',
      });

      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await flushMicrotasks();

      expect(callCount).toBe(countAfterMount + 1);
    } finally {
      if (originalVisibilityState) {
        Object.defineProperty(document, 'visibilityState', originalVisibilityState);
      } else {
        Reflect.deleteProperty(document, 'visibilityState');
      }
    }
  });

  it('refetches when credentials.switched fires for matching clientId', async () => {
    const calls: number[] = [];

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        calls.push(Date.now());
        ctx.setResult({ usage: makeUsage(Date.now()) });
      }),
    );

    renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), { wrapper: makeBusWrapper(bus) });

    await waitFor(() => expect(calls).toHaveLength(1));

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.switched, {
        clientId: 'other-client',
        from: null,
        to: { id: 'acc-2', active: true, metadata: {}, detectedAt: 1, lastSeenAt: 1 },
      });
    });

    expect(calls).toHaveLength(1);

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.switched, {
        clientId: CLIENT_ID,
        from: null,
        to: { id: 'acc-2', active: true, metadata: {}, detectedAt: 1, lastSeenAt: 1 },
      });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
  });

  it('refetches when credentials.refreshed fires for matching account', async () => {
    const calls: number[] = [];

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        calls.push(Date.now());
        ctx.setResult({ usage: makeUsage(Date.now()) });
      }),
    );

    renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), { wrapper: makeBusWrapper(bus) });

    await waitFor(() => expect(calls).toHaveLength(1));

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.refreshed, {
        clientId: CLIENT_ID,
        account: { id: 'other-account', active: true, metadata: {}, detectedAt: 1, lastSeenAt: 1 },
      });
    });

    expect(calls).toHaveLength(1);

    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.refreshed, {
        clientId: CLIENT_ID,
        account: { id: ACCOUNT_ID, active: true, metadata: {}, detectedAt: 1, lastSeenAt: 1 },
      });
    });

    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
  });

  it('updates data instantly when usage.updated fires for matching account', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: null });
      }),
    );

    const { result } = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeBusWrapper(bus),
    });

    // Wait for initial fetch.
    await waitFor(() => expect(result.current.loading).toBe(false));

    const updatedUsage = makeUsage(9_999_999);

    await act(async () => {
      await bus.emit(AccountManagerSubjects.usage.updated, {
        clientId: CLIENT_ID,
        accountId: ACCOUNT_ID,
        usage: updatedUsage,
      });
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(updatedUsage);
    });
  });

  it('keeps the pushed usage snapshot when an older usage.get resolves afterward', async () => {
    let resolveInitialRequest: (() => void) | null = null;

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        return new Promise<void>((resolve) => {
          resolveInitialRequest = () => {
            ctx.setResult({ usage: makeUsage(1_000_000) });
            resolve();
          };
        });
      }),
    );

    const { result } = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeBusWrapper(bus),
    });

    await waitFor(() => expect(resolveInitialRequest).not.toBeNull());

    const pushedUsage = makeUsage(9_999_999);
    await act(async () => {
      await bus.emit(AccountManagerSubjects.usage.updated, {
        clientId: CLIENT_ID,
        accountId: ACCOUNT_ID,
        usage: pushedUsage,
      });
    });

    expect(result.current.data).toEqual(pushedUsage);

    await act(async () => {
      resolveInitialRequest?.();
    });
    await flushMicrotasks();

    expect(result.current.data).toEqual(pushedUsage);
    expect(result.current.error).toBeNull();
  });

  it('does not update data when usage.updated fires for a different account', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: null });
      }),
    );

    const { result } = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeBusWrapper(bus),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await bus.emit(AccountManagerSubjects.usage.updated, {
        clientId: CLIENT_ID,
        accountId: 'other-account',
        usage: makeUsage(1),
      });
    });

    expect(result.current.data).toBeNull();
  });

  it('refresh() calls usage.refresh (not usage.get)', async () => {
    const refreshCalls: Array<{ clientId?: string; accountId?: string }> = [];
    const getCalls: number[] = [];

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        getCalls.push(1);
        ctx.setResult({ usage: null });
      }),
    );

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.refresh, (ctx) => {
        refreshCalls.push(ctx.payload);
        ctx.setResult({ refreshed: 1 });
      }),
    );

    const { result } = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeBusWrapper(bus),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    const getCntBeforeRefresh = getCalls.length;

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(refreshCalls).toHaveLength(1);
      expect(refreshCalls[0]).toMatchObject({
        clientId: CLIENT_ID,
        accountId: ACCOUNT_ID,
      });
    });

    // usage.get should NOT have been called by refresh().
    expect(getCalls.length).toBe(getCntBeforeRefresh);
  });

  it('returns no-op shape when bus is absent', () => {
    const { result } = renderHook(() => useUsageData({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }), {
      wrapper: makeNullBusWrapper(),
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    // refresh() should be callable without throwing.
    expect(() => result.current.refresh()).not.toThrow();
  });
});
