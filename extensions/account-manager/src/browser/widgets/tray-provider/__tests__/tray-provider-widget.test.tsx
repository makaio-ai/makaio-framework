/**
 * Tests for TrayProviderWidget.
 *
 * Verifies rendering with a real bus and real handlers, expected hook
 * invocation paths, the credentials.switch emission on switch-button click,
 * and the null-bus read-only degradation path.
 *
 * Uses a real bus and real subject handlers — no mocked bus.
 */

import { createElement, type ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AccountManagerSubjects } from '@makaio-community/account-manager/register';
import type { Account, AccountUsage, SourceInfo } from '@makaio-community/account-manager/schemas';
import { BusContext } from '@makaio/ui-hooks';
import { clearUsageCache } from '../../../data/use-usage-data.js';
import { trayProviderWidgetDefinition } from '../tray-provider-widget.js';
import { TEST_UI_CONTEXT } from '../../../__tests__/test-utils.js';

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
 * Renders the TrayProviderWidget using its definition component.
 * @param wrapper - React wrapper supplying bus context.
 * @returns The render result.
 */
function renderWidget(wrapper: ReturnType<typeof makeBusWrapper | typeof makeNullBusWrapper>) {
  const noop = (): void => {};
  return render(
    createElement(trayProviderWidgetDefinition.component, {
      size: 'small',
      config: {},
      updateConfig: noop,
      uiContext: TEST_UI_CONTEXT,
    }),
    { wrapper },
  );
}

/**
 * Registers a `usage.get` handler with the real subject response shape.
 *
 * The bus contract returns `{ usage }`, and `useUsageData()` reads
 * `result.usage` directly, so tests intentionally mirror that shape instead of
 * flattening the nested payload.
 * @param bus - Bus instance under test.
 * @param subscriptions - Cleanup collection for bus handlers.
 * @param usage - Usage snapshot to return from the handler.
 */
function registerUsageGet(bus: IMakaioBus, subscriptions: Array<() => void>, usage: AccountUsage | null): void {
  subscriptions.push(
    bus.on(AccountManagerSubjects.usage.get, (ctx) => {
      ctx.setResult({ usage });
    }),
  );
}

/**
 * Registers the account source/list handlers used by the tray widget tests.
 *
 * Centralizing the real bus wiring keeps the fixtures aligned with the
 * production subject contracts without repeating the same handler boilerplate
 * in every case.
 * @param bus - Bus instance under test.
 * @param subscriptions - Cleanup collection for bus handlers.
 * @param sources - Provider sources returned by `accounts.getSources`.
 * @param listAccounts - Per-source account resolver for `accounts.list`.
 */
function registerAccountQueries(
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

describe('TrayProviderWidget', () => {
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

  it('renders a loading placeholder while the source request is in flight', async () => {
    const responseGate = createDeferred<void>();

    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, async (ctx) => {
        await responseGate.promise;
        ctx.setResult({ sources: [] });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    expect(screen.getByText('Loading…')).toBeInTheDocument();

    responseGate.resolve();

    await waitFor(() => {
      expect(screen.getByText('No providers configured.')).toBeInTheDocument();
    });
  });

  it('renders provider name and accounts after data loads', async () => {
    const source = makeSource('claude-code', 'Claude');
    const account = makeAccount('acc-1', true);

    registerAccountQueries(bus, subscriptions, [source], () => [account]);
    registerUsageGet(bus, subscriptions, null);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Claude')).toBeInTheDocument();
    });
    expect(screen.getByText('acc-1')).toBeInTheDocument();
  });

  it('renders multiple providers', async () => {
    registerAccountQueries(
      bus,
      subscriptions,
      [makeSource('claude-code', 'Claude'), makeSource('codex', 'Codex')],
      (clientId) => [makeAccount(`${clientId}-acc`, true)],
    );
    registerUsageGet(bus, subscriptions, null);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Claude')).toBeInTheDocument();
      expect(screen.getByText('Codex')).toBeInTheDocument();
    });
  });

  it('emits credentials.switch when the switch button is clicked', async () => {
    const user = userEvent.setup();
    const switched: Array<{ clientId: string; accountId: string }> = [];

    registerAccountQueries(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-active', true),
      makeAccount('acc-inactive', false),
    ]);
    registerUsageGet(bus, subscriptions, null);
    subscriptions.push(
      bus.on(AccountManagerSubjects.credentials.switch, (ctx) => {
        switched.push(ctx.payload);
        ctx.setResult({ success: true });
      }),
    );

    renderWidget(makeBusWrapper(bus));

    // Wait for the inactive account switch button to appear.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /switch to acc-inactive/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /switch to acc-inactive/i }));

    await waitFor(() => {
      expect(switched).toHaveLength(1);
      expect(switched[0]).toMatchObject({ clientId: 'claude-code', accountId: 'acc-inactive' });
    });
  });

  it('does not render switch button for active accounts', async () => {
    registerAccountQueries(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-active', true),
    ]);
    registerUsageGet(bus, subscriptions, null);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('acc-active')).toBeInTheDocument();
    });

    expect(screen.queryByRole('button', { name: /switch/i })).not.toBeInTheDocument();
  });

  it('shows account-service-unavailable read-only state when bus is absent', () => {
    renderWidget(makeNullBusWrapper());
    expect(screen.getByText('Account service unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch/i })).not.toBeInTheDocument();
  });

  it('shows a partial-data notice and keeps available providers visible when one fetch fails', async () => {
    registerAccountQueries(
      bus,
      subscriptions,
      [makeSource('claude-code', 'Claude'), makeSource('codex', 'Codex')],
      (clientId) => {
        if (clientId === 'codex') {
          throw new Error('codex unavailable');
        }
        return [makeAccount('acc-1', true)];
      },
    );
    registerUsageGet(bus, subscriptions, null);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Claude')).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('Account data may be incomplete.');
    });
  });

  it('shows empty-provider message when no sources are configured', async () => {
    registerAccountQueries(bus, subscriptions, [], () => []);

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('No providers configured.')).toBeInTheDocument();
    });
  });

  it('shows retry when the initial source fetch fails', async () => {
    subscriptions.push(
      bus.on(AccountManagerSubjects.accounts.getSources, () => {
        throw new Error('source failure');
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Unable to load accounts.');
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });
  });

  it('renders usage gauges when usage data is available', async () => {
    registerAccountQueries(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-1', true),
    ]);
    registerUsageGet(bus, subscriptions, {
      fetchedAt: Date.now(),
      windows: [
        {
          id: '5h',
          label: '5 Hour',
          utilization: 42,
          resetsAt: Date.now() + 3_600_000,
          windowSeconds: 18_000,
        },
      ],
    });

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('5 Hour')).toBeInTheDocument();
      expect(screen.getByText('42%')).toBeInTheDocument();
    });
  });

  it('shows usage-unavailable message when a usage fetch fails', async () => {
    registerAccountQueries(bus, subscriptions, [makeSource('claude-code', 'Claude')], () => [
      makeAccount('acc-1', true),
    ]);
    subscriptions.push(
      bus.on(AccountManagerSubjects.usage.get, () => {
        throw new Error('usage failure');
      }),
    );

    renderWidget(makeBusWrapper(bus));

    await waitFor(() => {
      expect(screen.getByText('Usage unavailable.')).toBeInTheDocument();
    });
  });
});
