/**
 * Tests for AnalyticsPage.
 *
 * Verifies:
 * - Header title is rendered.
 * - Range selector buttons are rendered.
 * - The default active range button is "7d".
 * - Account selector populates when accounts are available.
 * - Clicking a range button changes the active selection.
 * - Range bounds keep advancing while the page stays open.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio-community/account-manager/register';
import { PreferencesSubjects } from '@makaio/services-core/preferences';
import type { Account, SourceInfo } from '@makaio-community/account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import type { WidgetDefinition, WidgetLayout } from '@makaio/ui-kernel';
import { widgetRegistry } from '@makaio/ui-kernel';
import '../../../scopes.js';
import AnalyticsPage from '../analytics-page.js';
import { useAnalyticsContext } from '../analytics-context.js';
import { flushMicrotasks } from '../../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal active Account fixture.
 * @param id - Account identifier.
 * @returns A valid Account object.
 */
function makeAccount(id: string): Account {
  return {
    id,
    active: true,
    metadata: {},
    detectedAt: 1_000,
    lastSeenAt: 2_000,
  };
}

/**
 * Minimal SourceInfo fixture.
 * @param clientId - Credential-source identifier.
 * @returns A valid SourceInfo object.
 */
function makeSource(clientId: string): SourceInfo {
  return { clientId, displayName: clientId, available: true };
}

/**
 * Probe widget rendered through the real WidgetCanvas to expose analytics bounds.
 * @returns Rendered probe element.
 */
function AnalyticsProbeWidget(): ReactNode {
  const filter = useAnalyticsContext();
  return createElement('div', {
    'data-testid': 'analytics-filter',
    'data-from': String(filter.from),
    'data-to': String(filter.to),
  });
}

const ANALYTICS_PROBE_WIDGET: WidgetDefinition<Record<string, never>> = {
  id: 'account-manager:test-analytics-probe',
  name: 'Analytics Probe',
  scope: 'account-manager:analytics',
  description: 'Test-only analytics context probe.',
  component: AnalyticsProbeWidget,
  supportedSizes: ['small'],
  defaultSize: 'small',
  allowMultiple: false,
};

function makeProbeLayout(): WidgetLayout {
  return {
    version: 1,
    placements: [
      {
        instanceId: 'analytics-probe-instance',
        widgetId: ANALYTICS_PROBE_WIDGET.id,
        col: 1,
        row: 1,
        size: 'small',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Wraps the analytics page with a real bus context.
 * @param bus - Bus instance.
 * @returns React wrapper.
 */
function makeBusWrapper(bus: IMakaioBus) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(BusContext.Provider, { value: bus }, children);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stubs the `getSources` bus handler for the duration of a test.
 * @param bus - Bus instance to register the stub on.
 * @param subscriptions - Subscriptions array to push the teardown into.
 * @param sources - Source list to return from the stub (defaults to empty).
 */
function stubGetSources(bus: IMakaioBus, subscriptions: Array<() => void>, sources: SourceInfo[] = []): void {
  subscriptions.push(
    bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
      ctx.setResult({ sources });
    }),
  );
}

/**
 * Renders the analytics page with real bus handlers and an optional source list.
 * Keeps the test on the real WidgetCanvas path while varying only account-manager data.
 * @param bus - Bus instance under test.
 * @param subscriptions - Cleanup collection for bus handlers.
 * @param sources - Source list exposed through the real bus contract.
 * @param beforeRender - Optional setup that must be registered before mount.
 * @returns The Testing Library render result.
 */
function renderAnalyticsPage(
  bus: IMakaioBus,
  subscriptions: Array<() => void>,
  sources: SourceInfo[] = [],
  beforeRender?: () => void,
) {
  stubGetSources(bus, subscriptions, sources);
  beforeRender?.();
  return render(createElement(AnalyticsPage), { wrapper: makeBusWrapper(bus) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnalyticsPage', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;
  let preferenceValue: unknown;

  beforeEach(() => {
    bus = createBusInstance();
    subscriptions = [];
    preferenceValue = null;
    widgetRegistry.clear();

    // Stub widget layout preference load (returns nothing).
    // Validate the full layout-preference contract so the page cannot silently
    // drift to a different key or category.
    subscriptions.push(
      bus.on(PreferencesSubjects.get, (ctx) => {
        expect(ctx.payload).toEqual({
          category: 'widget-layout',
          key: {
            scope: 'account-manager:analytics',
            surface: 'ui',
          },
        });
        ctx.setResult({ value: preferenceValue });
      }),
    );
  });

  afterEach(() => {
    subscriptions.forEach((unsub) => unsub());
    widgetRegistry.clear();
  });

  it('renders the Analytics header title', () => {
    renderAnalyticsPage(bus, subscriptions);

    expect(screen.getByText('Analytics')).toBeInTheDocument();
  });

  it('renders range selector buttons', () => {
    renderAnalyticsPage(bus, subscriptions);

    expect(screen.getByRole('button', { name: '24 h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '7 d' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '30 d' })).toBeInTheDocument();
  });

  it('activates the "7d" range button by default', () => {
    renderAnalyticsPage(bus, subscriptions);

    expect(screen.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '24 h' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '30 d' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders account selector when accounts are available', async () => {
    renderAnalyticsPage(bus, subscriptions, [makeSource('claude-code')], () => {
      subscriptions.push(
        bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
          ctx.setResult({ accounts: [makeAccount('acc-1')] });
        }),
      );
    });

    await waitFor(() => {
      const accountSelect = screen.getByLabelText('Account');
      const accountOptions = within(accountSelect)
        .getAllByRole('option')
        .filter((option) => option.getAttribute('value') !== '');

      expect(accountSelect).toBeInTheDocument();
      expect(accountOptions.length).toBeGreaterThan(0);
    });
  });

  it('updates range context when a different range button is clicked', async () => {
    const user = userEvent.setup();

    renderAnalyticsPage(bus, subscriptions);

    const btn30d = screen.getByRole('button', { name: '30 d' });

    // Initially 7d is active.
    expect(screen.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(btn30d);

    expect(btn30d).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '7 d' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('refreshes range bounds while the page remains open', async () => {
    vi.useFakeTimers();

    try {
      widgetRegistry.register(ANALYTICS_PROBE_WIDGET);
      preferenceValue = makeProbeLayout();
      renderAnalyticsPage(bus, subscriptions);

      await flushMicrotasks();
      const filterNode = screen.getByTestId('analytics-filter');
      const initialTo = Number(filterNode.getAttribute('data-to'));

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await flushMicrotasks();
      });

      // `waitFor` polls via timers, so switch back after the fake-timer-driven update is flushed.
      vi.useRealTimers();

      await waitFor(() => {
        const advancedTo = Number(screen.getByTestId('analytics-filter').getAttribute('data-to'));
        expect(advancedTo).toBeGreaterThan(initialTo);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
