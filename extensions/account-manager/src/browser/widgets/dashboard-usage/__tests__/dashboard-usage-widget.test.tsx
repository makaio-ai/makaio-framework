/**
 * Tests for DashboardUsageWidget.
 *
 * Verifies KPI tile rendering with real bus handlers, switch-count
 * increment on credentials.switched events, headroom gauge rendering,
 * and the null-bus degradation path.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/register';
import type { Account, AccountUsage, SourceInfo } from '@makaio/extension-account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { clearUsageCache } from '../../../data/use-usage-data.js';
import { dashboardUsageWidgetDefinition } from '../dashboard-usage-widget.js';
import { TEST_UI_CONTEXT } from '../../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal active Account fixture.
 * @param id - Account identifier.
 * @returns A valid active Account object.
 */
function makeActiveAccount(id: string): Account {
  return {
    id,
    active: true,
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

/**
 * Builds a minimal usage snapshot.
 * @param utilization - Utilization percentage 0–100 for the single window.
 * @returns A valid AccountUsage object.
 */
function makeUsage(utilization: number): AccountUsage {
  return {
    fetchedAt: Date.now(),
    windows: [
      {
        id: '5h',
        label: '5 Hour',
        utilization,
        resetsAt: Date.now() + 3_600_000,
        windowSeconds: 18_000,
      },
    ],
  };
}

/**
 * Creates a deferred promise for pausing usage RPCs in loading-state tests.
 * @returns Deferred promise controls.
 */
function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Wraps the widget under test with a real bus context.
 * @param bus - Bus instance to expose via context.
 * @returns React wrapper component.
 */
function makeBusWrapper(bus: IMakaioBus) {
  return function BusWrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: bus }, children);
  };
}

/**
 * Wraps the widget under test without any bus context (null-bus path).
 * @returns React wrapper component.
 */
function makeNullBusWrapper() {
  return function NullBusWrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: null }, children);
  };
}

/**
 * Renders the DashboardUsageWidget using its definition component.
 * @param wrapper - React wrapper supplying bus context.
 * @returns The render result.
 */
function renderWidget(wrapper: ReturnType<typeof makeBusWrapper | typeof makeNullBusWrapper>) {
  const noop = (): void => {};
  return render(
    createElement(dashboardUsageWidgetDefinition.component, {
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

describe('DashboardUsageWidget', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    clearUsageCache();
    bus = createBusInstance();
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach((unsub) => unsub());
  });

  it('renders a loading placeholder while accounts are fetching', () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, () => {
        // Never responds.
      }),
    );

    renderWidget(makeBusWrapper(bus));

    expect(screen.getByText('Loading usage data…')).toBeInTheDocument();
  });

  it('renders KPI tiles after data loads', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [makeActiveAccount('acc-1')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: null });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Active')).toBeInTheDocument();
      expect(screen.getByText('Peak')).toBeInTheDocument();
      expect(screen.getByText('Switches')).toBeInTheDocument();
    });
  });

  it('shows active count matching the number of active accounts', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({
          sources: [makeSource('claude-code'), makeSource('codex')],
        });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        if (ctx.payload.clientId === 'claude-code') {
          ctx.setResult({ accounts: [makeActiveAccount('acc-1'), makeActiveAccount('acc-2')] });
        } else {
          ctx.setResult({ accounts: [makeActiveAccount('acc-3')] });
        }
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: null });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    // Three active accounts across two providers.
    await waitFor(() => {
      const activeTitle = screen.getByText('Active');
      const activeTile = activeTitle.parentElement!;
      expect(within(activeTile).getByText('3')).toBeInTheDocument();
    });
  });

  it('increments switch count when credentials.switched fires', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [makeActiveAccount('acc-1')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: null });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    // Initial switch count is 0.
    await waitFor(() => {
      expect(screen.getByText('Switches')).toBeInTheDocument();
    });

    // Emit a switch event.
    await act(async () => {
      await bus.emit(AccountManagerSubjects.credentials.switched, {
        clientId: 'claude-code',
        from: null,
        to: makeActiveAccount('acc-2'),
      });
    });

    // After the switch event the "Switches" KPI tile text content should
    // include "1". We locate the tile by its title and then assert the
    // combined textContent of its container which holds both title and value.
    await waitFor(() => {
      const switchesTitle = screen.getByText('Switches');
      // The KpiTile root contains the title, value, and sub spans.
      // parentElement is the .kpiTile div.
      const tileRoot = switchesTitle.parentElement!;
      expect(within(tileRoot).getByText('1')).toBeInTheDocument();
    });
  });

  it('renders headroom gauge when usage data is available', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [makeActiveAccount('acc-1')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, (ctx) => {
        ctx.setResult({ usage: makeUsage(55) });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Headroom')).toBeInTheDocument();
      expect(screen.getByText('5 Hour')).toBeInTheDocument();
      expect(screen.getByText('55%')).toBeInTheDocument();
    });
  });

  it('renders without crashing when bus is absent', () => {
    // When no bus is present, useAccounts() returns loading: false + empty
    // sources, so the widget skips loading and renders the KPI tiles with
    // zero active accounts. No crash expected.
    renderWidget(makeNullBusWrapper());
    // KPI tiles should be present even without data.
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Switches')).toBeInTheDocument();
  });

  it('shows loading state instead of empty usage while account snapshots are still in flight', async () => {
    const responseGate = createDeferred<void>();

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [makeSource('claude-code')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
        ctx.setResult({ accounts: [makeActiveAccount('acc-1')] });
      }),
    );
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, async () => {
        await responseGate.promise;
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      const peakTile = screen.getByText('Peak').parentElement as HTMLElement;
      expect(within(peakTile).getByText('—')).toBeInTheDocument();
      expect(within(peakTile).getByText('loading')).toBeInTheDocument();
      expect(screen.getByText('Loading…')).toBeInTheDocument();
    });

    responseGate.resolve();
  });
});
