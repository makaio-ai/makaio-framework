/**
 * Tests for useAccountHistory hook.
 *
 * Verifies RPC invocation, cache hit on repeat identical requests, reload on
 * filter/range change, and null-bus no-op path.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio-community/account-manager/register';
import type { UsageEntry } from '@makaio-community/account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { flushDebounce } from '../../__tests__/test-utils.js';
import { clearHistoryCache, useAccountHistory } from '../use-account-history.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLIENT_ID = 'claude-code';
const ACCOUNT_ID = 'acc-1';
const RANGE = { from: 1_000_000, to: 2_000_000 };

interface HistoryRequestPayload {
  accountId: string;
  clientId: string;
  from: number;
  to: number;
  windowId?: string;
}

interface HistoryRequestContext {
  payload: HistoryRequestPayload;
  setResult: (result: { entries: UsageEntry[] }) => void;
}

/**
 * Builds a minimal UsageEntry fixture.
 * @param ts - Epoch ms for the observation timestamp.
 * @returns A valid UsageEntry.
 */
function makeEntry(ts: number): UsageEntry {
  return {
    ts,
    windowId: '5h',
    utilization: 42,
    resetsAt: ts + 3_600_000,
    blocked: false,
  };
}

/**
 * Registers the usage.history handler used across hook tests.
 * @param bus - Bus instance under test.
 * @param subscriptions - Cleanup collection for bus handlers.
 * @param onRequest - Handler invoked for each usage.history request.
 */
function registerHistoryHandler(
  bus: IMakaioBus,
  subscriptions: Array<() => void>,
  onRequest: (ctx: HistoryRequestContext) => void,
): void {
  subscriptions.push(
    bus.on(AccountManagerSubjects.usage.history, (ctx) => {
      onRequest(ctx);
    }),
  );
}

/**
 * Renders the default history hook for the shared test account/range.
 * @param bus - Bus instance under test.
 * @returns Hook render result.
 */
function renderDefaultHistory(bus: IMakaioBus) {
  return renderHook(() => useAccountHistory({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }, RANGE), {
    wrapper: makeBusWrapper(bus),
  });
}

/**
 * Renders the history hook with a variable accountId and the shared range.
 * @param bus - Bus instance under test.
 * @param initialAccountId - Initial account selection for the hook.
 * @returns Hook render result with rerender support.
 */
function renderHistoryByAccount(bus: IMakaioBus, initialAccountId = ACCOUNT_ID) {
  return renderHook<ReturnType<typeof useAccountHistory>, { accountId: string }>(
    ({ accountId }) => useAccountHistory({ clientId: CLIENT_ID, accountId }, RANGE),
    {
      wrapper: makeBusWrapper(bus),
      initialProps: { accountId: initialAccountId },
    },
  );
}

/**
 * Renders the history hook with a variable time range for the shared account.
 * @param bus - Bus instance under test.
 * @param initialRange - Initial time range for the hook.
 * @returns Hook render result with rerender support.
 */
function renderHistoryByRange(bus: IMakaioBus, initialRange = RANGE) {
  return renderHook<ReturnType<typeof useAccountHistory>, { from: number; to: number }>(
    ({ from, to }) => useAccountHistory({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }, { from, to }),
    {
      wrapper: makeBusWrapper(bus),
      initialProps: initialRange,
    },
  );
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

describe('useAccountHistory', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    clearHistoryCache();
    vi.useFakeTimers();
    bus = createBusInstance();
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
    vi.clearAllTimers();
    // Always restore real timers, even if the test itself timed out.
    vi.useRealTimers();
  });

  it('calls usage.history with the correct payload', async () => {
    const capturedPayloads: HistoryRequestPayload[] = [];

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      capturedPayloads.push(ctx.payload);
      ctx.setResult({ entries: [makeEntry(1_500_000)] });
    });

    const { result } = renderDefaultHistory(bus);

    await flushDebounce();

    // Assert directly — waitFor relies on setInterval which is faked.
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    expect(capturedPayloads[0]).toMatchObject({
      clientId: CLIENT_ID,
      accountId: ACCOUNT_ID,
      from: RANGE.from,
      to: RANGE.to,
    });
  });

  it('returns entries in the received order', async () => {
    const entries = [makeEntry(1_100_000), makeEntry(1_200_000), makeEntry(1_300_000)];

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      ctx.setResult({ entries });
    });

    const { result } = renderDefaultHistory(bus);

    await flushDebounce();

    expect(result.current.entries).toEqual(entries);
  });

  it('cache hit: does not call usage.history on repeat identical request', async () => {
    let callCount = 0;

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      callCount += 1;
      ctx.setResult({ entries: [makeEntry(1_500_000)] });
    });

    const { rerender, result } = renderDefaultHistory(bus);

    await flushDebounce();

    expect(result.current.entries).toHaveLength(1);
    expect(callCount).toBe(1);

    // Re-render with identical props — should hit cache, no new RPC.
    rerender();

    // Advance past the debounce window; cache hit path skips doFetch entirely.
    await flushDebounce();

    expect(callCount).toBe(1);
  });

  it('cache hit survives unmount and remount for the same request key', async () => {
    let callCount = 0;

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      callCount += 1;
      ctx.setResult({ entries: [makeEntry(1_500_000)] });
    });

    const firstRender = renderDefaultHistory(bus);

    await flushDebounce();

    expect(firstRender.result.current.entries).toHaveLength(1);
    expect(callCount).toBe(1);

    firstRender.unmount();

    const secondRender = renderDefaultHistory(bus);

    await flushDebounce();

    expect(secondRender.result.current.entries).toHaveLength(1);
    expect(callCount).toBe(1);
  });

  it('deduplicates concurrent subscribers for the same request key', async () => {
    let callCount = 0;

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      callCount += 1;
      ctx.setResult({ entries: [makeEntry(1_500_000)] });
    });

    const first = renderDefaultHistory(bus);
    const second = renderDefaultHistory(bus);

    await flushDebounce();

    expect(callCount).toBe(1);
    expect(first.result.current.entries).toHaveLength(1);
    expect(second.result.current.entries).toHaveLength(1);
  });

  it('reloads on filter change (new accountId)', async () => {
    const capturedIds: string[] = [];

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      capturedIds.push(ctx.payload.accountId);
      ctx.setResult({ entries: [] });
    });

    const { rerender } = renderHistoryByAccount(bus);

    await flushDebounce();

    expect(capturedIds).toHaveLength(1);

    rerender({ accountId: 'acc-2' });

    await flushDebounce();

    expect(capturedIds).toHaveLength(2);
    expect(capturedIds[1]).toBe('acc-2');
  });

  it('reloads on range change', async () => {
    const capturedFroms: number[] = [];

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      capturedFroms.push(ctx.payload.from);
      ctx.setResult({ entries: [] });
    });

    const { rerender } = renderHistoryByRange(bus);

    await flushDebounce();

    expect(capturedFroms).toHaveLength(1);

    rerender({ from: 3_000_000, to: 4_000_000 });

    await flushDebounce();

    expect(capturedFroms).toHaveLength(2);
    expect(capturedFroms[1]).toBe(3_000_000);
  });

  it('evicts the oldest cached range when sliding windows exceed the cache bound', async () => {
    let callCount = 0;

    registerHistoryHandler(bus, subscriptions, (ctx) => {
      callCount += 1;
      ctx.setResult({ entries: [makeEntry(ctx.payload.from + 1)] });
    });

    const initialRange = { from: 0, to: 10 };
    const { rerender, result } = renderHistoryByRange(bus, initialRange);

    await flushDebounce();

    expect(result.current.entries).toHaveLength(1);
    expect(callCount).toBe(1);

    for (let i = 1; i <= 100; i += 1) {
      rerender({ from: i * 10, to: i * 10 + 10 });
      await flushDebounce();
    }

    expect(callCount).toBe(101);

    rerender(initialRange);
    await flushDebounce();

    expect(callCount).toBe(102);
    expect(result.current.entries[0]?.ts).toBe(1);
  });

  it('returns no-op shape when bus is absent', () => {
    const { result, rerender } = renderHook(
      () => useAccountHistory({ clientId: CLIENT_ID, accountId: ACCOUNT_ID }, RANGE),
      { wrapper: makeNullBusWrapper() },
    );

    expect(result.current.entries).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(() => result.current.reload()).not.toThrow();

    const firstResult = result.current;
    rerender();
    expect(result.current.entries).toBe(firstResult.entries);
    expect(result.current.loading).toBe(firstResult.loading);
    expect(result.current.error).toBe(firstResult.error);
    expect(result.current.reload).toBe(firstResult.reload);
  });
});
