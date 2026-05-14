/**
 * Tests for AnalyticsHeatmapWidget.
 *
 * Verifies:
 * - Correct cell count (7 × 24 = 168 cells).
 * - Intensity tier boundary values (utilization 0, 25, 50, 75, 100).
 * - Empty-data path renders cells with tier 0.
 * - Widget renders without crashing when bus is absent.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/subjects';
import type { UsageEntry } from '@makaio/extension-account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { clearHistoryCache } from '../../../data/use-account-history.js';
import { AnalyticsContext, type AnalyticsFilter } from '../../../pages/analytics/analytics-context.js';
import { analyticsHeatmapWidgetDefinition } from '../analytics-heatmap-widget.js';
import { flushDebounce, TEST_UI_CONTEXT } from '../../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILTER: AnalyticsFilter = {
  clientId: 'claude-code',
  accountId: 'acc-1',
  from: 1_000_000,
  to: 2_000_000,
  range: '7d',
};

/**
 * Creates a UsageEntry at a specific UTC day-of-week and hour.
 *
 * We pick a reference epoch that falls on a known UTC time and offset by
 * day/hour increments. Sunday 2001-01-07 00:00:00 UTC = epoch 978,825,600,000.
 * @param day - UTC day of week (0 = Sunday).
 * @param hour - UTC hour (0–23).
 * @param utilization - Utilization percentage (0–100).
 * @returns A valid UsageEntry.
 */
function makeEntry(day: number, hour: number, utilization: number): UsageEntry {
  // Sunday 2001-01-07 00:00:00 UTC = epoch 978,825,600,000.
  // Verified: new Date(978_825_600_000).getUTCDay() === 0 (Sunday).
  const sundayEpoch = 978_825_600_000;
  const ts = sundayEpoch + day * 86_400_000 + hour * 3_600_000;
  return {
    ts,
    windowId: '5h',
    utilization,
    resetsAt: ts + 3_600_000,
    blocked: false,
  };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Wraps the widget with bus and analytics contexts.
 * @param bus - Bus instance (may be null for null-bus tests).
 * @param filter - Analytics filter to provide.
 * @returns React wrapper.
 */
function makeWrapper(bus: IMakaioBus | null, filter: AnalyticsFilter = FILTER) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      BusContext.Provider,
      { value: bus },
      createElement(AnalyticsContext.Provider, { value: filter }, children),
    );
  };
}

/**
 * Renders the heatmap widget using its definition component.
 * @param wrapper - React wrapper.
 * @returns Render result.
 */
function renderWidget(wrapper: ReturnType<typeof makeWrapper>) {
  const noop = (): void => {};
  return render(
    createElement(analyticsHeatmapWidgetDefinition.component, {
      size: 'large',
      config: {},
      updateConfig: noop,
      uiContext: TEST_UI_CONTEXT,
    }),
    { wrapper },
  );
}

/**
 * Registers an empty usage-history response for the widget tests.
 * @param bus - Bus instance under test.
 * @param subscriptions - Cleanup collection for bus handlers.
 */
function registerEmptyHistorySubscription(bus: IMakaioBus, subscriptions: Array<() => void>): void {
  subscriptions.push(
    bus.on(AccountManagerSubjects.usage.history, (ctx) => {
      ctx.setResult({ entries: [] });
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsHeatmapWidget', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    clearHistoryCache();
    vi.useFakeTimers();
    bus = createBusInstance();
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach((unsub) => unsub());
    vi.useRealTimers();
  });

  it('renders exactly 168 cell elements (7 days × 24 hours)', () => {
    registerEmptyHistorySubscription(bus, subscriptions);

    renderWidget(makeWrapper(bus));

    const cells = screen.getAllByRole('cell');
    expect(cells).toHaveLength(168);
  });

  it('assigns tier 0 to all cells when there is no data', async () => {
    registerEmptyHistorySubscription(bus, subscriptions);

    renderWidget(makeWrapper(bus));

    await flushDebounce();

    const cells = screen.getAllByRole('cell');
    cells.forEach((cell) => {
      expect(cell.getAttribute('data-intensity')).toBe('0');
    });
  });

  it('maps utilization boundary values to correct intensity tiers', async () => {
    // Boundary: 0 → tier 1,
    // 25 → tier 1, 26 → tier 2, 50 → tier 2, 51 → tier 3, 75 → tier 3, 76 → tier 4.
    // We test representative values across distinct UTC day/hour combos.
    const entries: UsageEntry[] = [
      makeEntry(0, 0, 0), // explicit zero → tier 1
      makeEntry(0, 1, 25), // at boundary → tier 1
      makeEntry(0, 2, 26), // just above 25 → tier 2
      makeEntry(0, 3, 50), // at boundary → tier 2
      makeEntry(0, 4, 51), // just above 50 → tier 3
      makeEntry(0, 5, 75), // at boundary → tier 3
      makeEntry(0, 6, 76), // just above 75 → tier 4
      makeEntry(0, 7, 100), // max → tier 4
    ];

    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.history, (ctx) => {
        ctx.setResult({ entries });
      }),
    );

    renderWidget(makeWrapper(bus));

    // Helper: find the cell for a stable UTC grid slot, independent of label text.
    const cellAt = (hour: number): Element => {
      const cells = screen.getAllByRole('cell');
      const cell = cells.find(
        (candidate) =>
          candidate.getAttribute('data-day-index') === '0' && candidate.getAttribute('data-hour') === String(hour),
      );
      expect(cell, `Missing heatmap cell for UTC day 0 hour ${hour}`).toBeDefined();
      return cell!;
    };

    // Advance past the 250 ms debounce + drain the RPC microtask chain.
    await flushDebounce();

    expect(cellAt(0).getAttribute('data-intensity')).toBe('1');
    expect(cellAt(1).getAttribute('data-intensity')).toBe('1');
    expect(cellAt(2).getAttribute('data-intensity')).toBe('2');
    expect(cellAt(3).getAttribute('data-intensity')).toBe('2');
    expect(cellAt(4).getAttribute('data-intensity')).toBe('3');
    expect(cellAt(5).getAttribute('data-intensity')).toBe('3');
    expect(cellAt(6).getAttribute('data-intensity')).toBe('4');
    expect(cellAt(7).getAttribute('data-intensity')).toBe('4');
  });

  it('renders without crashing when bus is absent', () => {
    renderWidget(makeWrapper(null));
    // Cells still render; all at tier 0 (no data).
    const cells = screen.getAllByRole('cell');
    expect(cells).toHaveLength(168);
  });
});
