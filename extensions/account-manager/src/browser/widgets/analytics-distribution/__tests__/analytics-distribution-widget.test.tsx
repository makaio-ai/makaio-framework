/**
 * Tests for AnalyticsDistributionWidget.
 *
 * Verifies:
 * - Bar segments are rendered for each window type.
 * - Percentages across all segments sum to 100 (within rounding).
 * - Empty-data path shows the empty message.
 * - No-bus path renders without crashing.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/register';
import type { UsageEntry } from '@makaio/extension-account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { clearHistoryCache } from '../../../data/use-account-history.js';
import { AnalyticsContext, type AnalyticsFilter } from '../../../pages/analytics/analytics-context.js';
import { analyticsDistributionWidgetDefinition } from '../analytics-distribution-widget.js';
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
 * Builds a UsageEntry.
 * @param windowId - Rate-limit window slug.
 * @param utilization - Utilization percentage.
 * @returns A valid UsageEntry.
 */
function makeEntry(windowId: string, utilization: number): UsageEntry {
  return {
    ts: FROM + 1_000,
    windowId,
    utilization,
    resetsAt: FROM + 3_600_000,
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
 * Renders the distribution widget.
 * @param wrapper - React wrapper.
 * @returns Render result.
 */
function renderWidget(wrapper: ReturnType<typeof makeWrapper>) {
  const noop = (): void => {};
  return render(
    createElement(analyticsDistributionWidgetDefinition.component, {
      size: 'medium',
      config: {},
      updateConfig: noop,
      uiContext: TEST_UI_CONTEXT,
    }),
    { wrapper },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsDistributionWidget', () => {
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

  it('shows empty message when there are no entries', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.history, (ctx) => {
        ctx.setResult({ entries: [] });
      }),
    );

    renderWidget(makeWrapper(bus));
    await flushDebounce();

    expect(screen.getByText('No data for this period')).toBeInTheDocument();
  });

  it('renders legend entries for each window after data loads', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.history, (ctx) => {
        ctx.setResult({
          entries: [makeEntry('5h', 30), makeEntry('7d', 50), makeEntry('7d-sonnet', 20)],
        });
      }),
    );

    renderWidget(makeWrapper(bus));
    await flushDebounce();

    expect(screen.getByText('5h')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
    expect(screen.getByText('7d-sonnet')).toBeInTheDocument();
  });

  it('percentages sum to 100 (within 0.1 rounding)', async () => {
    // Three equal-weighted windows → each should be ~33.3%
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.history, (ctx) => {
        ctx.setResult({
          entries: [makeEntry('a', 100), makeEntry('b', 100), makeEntry('c', 100)],
        });
      }),
    );

    renderWidget(makeWrapper(bus));
    await flushDebounce();

    // Find all percentage labels (e.g. "33.3%" or "33.4%").
    const pctEls = screen.getAllByText(/^\d+(\.\d+)?%$/);
    expect(pctEls.length).toBe(3);

    const total = pctEls.reduce((sum, el) => {
      return sum + parseFloat(el.textContent!.replace('%', ''));
    }, 0);

    expect(total).toBeCloseTo(100, 1);
  });

  it('shows the empty-state contract when bus is absent', async () => {
    renderWidget(makeWrapper(null));
    await flushDebounce();
    expect(screen.getByText('No data for this period')).toBeInTheDocument();
    expect(screen.queryByText('Loading data…')).not.toBeInTheDocument();
    expect(screen.queryByText('Unable to load data for this period')).not.toBeInTheDocument();
  });
});
