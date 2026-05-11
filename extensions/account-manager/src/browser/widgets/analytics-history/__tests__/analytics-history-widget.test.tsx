/**
 * Tests for AnalyticsHistoryWidget.
 *
 * Verifies:
 * - SVG paths are rendered for multiple window series.
 * - Empty-data path doesn't crash and shows the empty message.
 * - No-bus path renders without crashing.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/register';
import type { UsageEntry } from '@makaio/extension-account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { clearHistoryCache } from '../../../data/use-account-history.js';
import { AnalyticsContext, type AnalyticsFilter } from '../../../pages/analytics/analytics-context.js';
import { analyticsHistoryWidgetDefinition } from '../analytics-history-widget.js';
import { flushDebounce, TEST_UI_CONTEXT } from '../../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FROM = 1_000_000;
const TO = 2_000_000;

const FILTER: AnalyticsFilter = {
  clientId: 'claude-code',
  accountId: 'acc-1',
  from: FROM,
  to: TO,
  range: '7d',
};

/**
 * Builds a UsageEntry at a given ts with the specified windowId.
 * @param ts - Epoch ms timestamp.
 * @param windowId - Rate-limit window slug.
 * @param utilization - Utilization percentage.
 * @returns A valid UsageEntry.
 */
function makeEntry(ts: number, windowId: string, utilization: number): UsageEntry {
  return {
    ts,
    windowId,
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
 * @param bus - Bus instance (may be null).
 * @param filter - Analytics filter.
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
 * Renders the history widget.
 * @param wrapper - React wrapper.
 * @returns Render result.
 */
function renderWidget(wrapper: ReturnType<typeof makeWrapper>) {
  const noop = (): void => {};
  return render(
    createElement(analyticsHistoryWidgetDefinition.component, {
      size: 'full-width',
      config: {},
      updateConfig: noop,
      uiContext: TEST_UI_CONTEXT,
    }),
    { wrapper },
  );
}

/**
 * Extracts the x coordinates from a two-point SVG line path.
 * @param d - SVG path `d` attribute.
 * @returns Pair of x coordinates in path order.
 */
function extractLineSegmentXs(d: string): [number, number] {
  const match = /^M([0-9.]+),[0-9.]+L([0-9.]+),[0-9.]+$/.exec(d);
  if (!match) {
    throw new Error(`Unexpected SVG path format: ${d}`);
  }
  return [Number(match[1]), Number(match[2])];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsHistoryWidget', () => {
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

  /**
   * Registers a bus handler that responds to `usage.history` with the given entries.
   * @param entries - Usage entries to return from the handler.
   */
  function registerHistory(entries: UsageEntry[]): void {
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.history, (ctx) => {
        ctx.setResult({ entries });
      }),
    );
  }

  it('shows empty message when there are no entries', async () => {
    registerHistory([]);

    renderWidget(makeWrapper(bus));

    await flushDebounce();

    expect(screen.getByText('No data for this period')).toBeInTheDocument();
  });

  it('renders SVG paths for multiple window series after data loads', async () => {
    const entries: UsageEntry[] = [
      makeEntry(FROM + 1_000, '5h', 30),
      makeEntry(FROM + 2_000, '5h', 45),
      makeEntry(FROM + 1_000, '7d', 60),
      makeEntry(FROM + 2_000, '7d', 70),
    ];

    registerHistory(entries);

    const { container } = renderWidget(makeWrapper(bus));
    await flushDebounce();

    // Each distinct windowId produces exactly one SVG path with rendered data.
    // The adjacent 'renders legend entries matching window IDs' test already covers
    // the public-contract side (via `getByText`); this test intentionally asserts on
    // SVG path rendering to exercise the chart output shape.
    const expectedSeriesCount = new Set(entries.map((entry) => entry.windowId)).size;
    const paths = container.querySelectorAll('svg path[d]');
    expect(paths).toHaveLength(expectedSeriesCount);
  });

  it('renders legend entries matching window IDs', async () => {
    const entries: UsageEntry[] = [makeEntry(FROM + 1_000, 'seriesA', 30), makeEntry(FROM + 2_000, 'seriesB', 50)];

    registerHistory(entries);

    renderWidget(makeWrapper(bus));
    await flushDebounce();

    expect(screen.getByText('seriesA')).toBeInTheDocument();
    expect(screen.getByText('seriesB')).toBeInTheDocument();
  });

  it('sorts each series by timestamp before generating its SVG path', async () => {
    const entries: UsageEntry[] = [makeEntry(FROM + 2_000, 'seriesB', 50), makeEntry(FROM + 1_000, 'seriesB', 30)];

    registerHistory(entries);

    const { container } = renderWidget(makeWrapper(bus));
    await flushDebounce();

    const path = container.querySelector('svg path[d]');
    expect(path).not.toBeNull();

    const d = path?.getAttribute('d');
    expect(d).not.toBeNull();

    const [firstX, secondX] = extractLineSegmentXs(d ?? '');
    expect(firstX).toBeLessThan(secondX);
  });

  it('shows the loading state before the history request resolves', () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.history, () => {
        // Keep the widget in loading state.
      }),
    );

    const { container } = renderWidget(makeWrapper(bus));

    expect(screen.getByText('Loading data…')).toBeInTheDocument();
    expect(screen.queryByLabelText('Usage history line chart')).not.toBeInTheDocument();
    expect(container.querySelector('svg path[d]')).toBeNull();
  });

  it('ignores pointer moves when the chart has a zero-size rect', async () => {
    const entries: UsageEntry[] = [makeEntry(FROM + 2_000, 'seriesB', 50), makeEntry(FROM + 1_000, 'seriesB', 30)];

    registerHistory(entries);

    renderWidget(makeWrapper(bus));
    await flushDebounce();

    const svg = screen.getByLabelText('Usage history line chart');
    Object.defineProperty(svg, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          width: 0,
          height: 0,
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          x: 0,
          y: 0,
          toJSON: () => '',
        }) satisfies DOMRect,
    });

    fireEvent.mouseMove(svg, { clientX: 5, clientY: 5 });

    expect(screen.queryByRole('presentation')).not.toBeInTheDocument();
  });

  it('renders without crashing when bus is absent', async () => {
    renderWidget(makeWrapper(null));
    await flushDebounce();
    // No bus → empty entries → empty message shown.
    expect(screen.getByText('No data for this period')).toBeInTheDocument();
  });
});
