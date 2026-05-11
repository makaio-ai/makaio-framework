/**
 * Tests for DashboardAccountsWidget.
 *
 * Verifies rendering with a real bus and real handlers, switch-button click
 * emission, last-seen timestamp rendering, and the null-bus read-only
 * degradation path.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio/extension-account-manager/register';
import type { Account, SourceInfo } from '@makaio/extension-account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { dashboardAccountsWidgetDefinition } from '../dashboard-accounts-widget.js';
import { TEST_UI_CONTEXT } from '../../../__tests__/test-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Account fixture.
 * @param id - Account identifier.
 * @param active - Whether the account is active.
 * @param lastSeenAt - Epoch ms for last-seen timestamp.
 * @param label - Optional display label for selector-stable fixtures.
 * @returns A valid Account object.
 */
function makeAccount(id: string, active = false, lastSeenAt = Date.now(), label?: string): Account {
  return {
    id,
    active,
    ...(label ? { label } : {}),
    metadata: {},
    detectedAt: 1_000,
    lastSeenAt,
  };
}

/**
 * Builds a minimal SourceInfo fixture.
 * @param clientId - Credential-source identifier.
 * @param displayName - Human-readable provider name.
 * @returns A valid SourceInfo object.
 */
function makeSource(clientId: string, displayName = clientId): SourceInfo {
  return { clientId, displayName, available: true };
}

/**
 * Creates a deferred promise for tests that need to pause a bus response.
 * @returns Deferred promise controls.
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
 * Renders the DashboardAccountsWidget using its definition component.
 * @param wrapper - React wrapper supplying bus context.
 * @returns The render result.
 */
function renderWidget(wrapper: ReturnType<typeof makeBusWrapper | typeof makeNullBusWrapper>) {
  const noop = (): void => {};
  return render(
    createElement(dashboardAccountsWidgetDefinition.component, {
      size: 'medium',
      config: {},
      updateConfig: noop,
      uiContext: TEST_UI_CONTEXT,
    }),
    { wrapper },
  );
}

/**
 * Registers the account source/list handlers used by the dashboard widget tests.
 * @param bus - Bus instance under test.
 * @param subscriptions - Cleanup collection for bus handlers.
 * @param sources - Provider sources returned by `accounts.getSources`.
 * @param listAccounts - Per-source account resolver for `accounts.list`.
 */
function registerAccountsHandlers(
  bus: IMakaioBus,
  subscriptions: Array<() => void>,
  sources: SourceInfo[],
  listAccounts: (clientId: string) => Account[],
): void {
  subscriptions.push(
    bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
      ctx.setResult({ sources });
    }),
  );
  subscriptions.push(
    bus.on(AccountManagerSubjects.accounts.list, (ctx) => {
      ctx.setResult({ accounts: listAccounts(ctx.payload.clientId) });
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DashboardAccountsWidget', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;

  beforeEach(() => {
    bus = createBusInstance();
    subscriptions = [];
  });

  afterEach(() => {
    subscriptions.forEach((unsub) => unsub());
  });

  it('renders a loading placeholder while accounts are fetching', async () => {
    const responseGate = createDeferred<void>();

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, async (ctx) => {
        await responseGate.promise;
        ctx.setResult({ sources: [] });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    expect(screen.getByText('Loading accounts…')).toBeInTheDocument();

    responseGate.resolve();

    await waitFor(() => {
      expect(screen.getByText('No providers configured.')).toBeInTheDocument();
    });
  });

  it('renders provider name and account count after data loads', async () => {
    registerAccountsHandlers(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-1', true),
      makeAccount('acc-2', false),
    ]);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Claude')).toBeInTheDocument();
    });
    expect(screen.getByText('2 accounts')).toBeInTheDocument();
  });

  it('renders "just now" for accounts seen very recently', async () => {
    registerAccountsHandlers(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-1', true, Date.now() - 10_000),
    ]);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('just now')).toBeInTheDocument();
    });
  });

  it('degrades invalid last-seen timestamps without throwing', async () => {
    registerAccountsHandlers(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-1', true, Number.NaN, 'Primary Account'),
    ]);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('unknown')).toBeInTheDocument();
    });
    expect(screen.getByText('unknown')).toHaveAttribute('title', 'Unknown last-seen time');
  });

  it('emits credentials.switch when the switch button is clicked', async () => {
    const user = userEvent.setup();
    const switched: Array<{ clientId: string; accountId: string }> = [];

    registerAccountsHandlers(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-inactive', false, Date.now(), 'Primary Account'),
    ]);
    subscriptions.push(
      bus.on(AccountManagerSubjects.credentials.switch, (ctx) => {
        switched.push(ctx.payload);
        ctx.setResult({ success: true });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /switch to primary account/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /switch to primary account/i }));

    await waitFor(() => {
      expect(switched).toHaveLength(1);
      expect(switched[0]).toMatchObject({ clientId: 'claude-code', accountId: 'acc-inactive' });
    });
  });

  it('does not render switch button for active accounts', async () => {
    registerAccountsHandlers(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-active', true, Date.now(), 'Already Active'),
    ]);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Already Active')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /switch/i })).not.toBeInTheDocument();
  });

  it('shows a partial-data notice and keeps available providers visible when one fetch fails', async () => {
    registerAccountsHandlers(
      bus,
      subscriptions,
      [makeSource('claude-code', 'Claude'), makeSource('codex', 'Codex')],
      (clientId) => {
        if (clientId === 'codex') {
          throw new Error('codex unavailable');
        }
        return [makeAccount('acc-1', true, Date.now(), 'Primary Account')];
      },
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Claude')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Account data may be incomplete.');
    });
  });

  it('shows account-service-unavailable message when bus is absent', () => {
    renderWidget(makeNullBusWrapper());
    expect(screen.getByText('Account service unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch/i })).not.toBeInTheDocument();
  });

  it('shows the Accounts title', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [] });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Accounts')).toBeInTheDocument();
    });
  });

  it('shows retry when the initial source fetch fails', async () => {
    const user = userEvent.setup();
    let callCount = 0;

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, () => {
        callCount += 1;
        throw new Error('source failure');
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Unable to load accounts.');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(callCount).toBeGreaterThan(1);
    });
  });

  it('shows empty message when no providers are configured', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, (ctx) => {
        ctx.setResult({ sources: [] });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('No providers configured.')).toBeInTheDocument();
    });
  });
});
