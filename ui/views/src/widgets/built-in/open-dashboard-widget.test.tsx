import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { HostSubjects, type UiContextSnapshot } from '@makaio/contracts';
import { BusProvider } from '@makaio/ui-hooks';
import type { WidgetProps } from '@makaio/ui-kernel';
import { frameworkOpenDashboardWidgetDefinition } from './open-dashboard-widget.js';

const TEST_UI_CONTEXT: UiContextSnapshot = {
  level: 'root',
  values: {},
};

const WIDGET_PROPS: WidgetProps = {
  config: {},
  size: 'small',
  uiContext: TEST_UI_CONTEXT,
  updateConfig: () => {},
};

/**
 * Creates a deferred promise for request-lifecycle tests.
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

/**
 * Render the open-dashboard widget with a concrete bus.
 * @param bus - Bus instance to expose via context.
 * @returns Testing Library render result.
 */
function renderOpenDashboardWidget(bus: IMakaioBus) {
  return render(
    createElement(BusProvider, {
      bus,
      children: createElement(frameworkOpenDashboardWidgetDefinition.component, WIDGET_PROPS),
    }),
  );
}

/**
 * Render the open-dashboard widget without a bus context (simulates
 * the case where no bus is available).
 * @returns Testing Library render result.
 */
function renderOpenDashboardWidgetWithoutBus() {
  return render(createElement(frameworkOpenDashboardWidgetDefinition.component, WIDGET_PROPS));
}

describe('frameworkOpenDashboardWidgetDefinition', () => {
  it('has the expected definition shape', () => {
    expect(frameworkOpenDashboardWidgetDefinition.id).toBe('framework-open-dashboard');
    expect(frameworkOpenDashboardWidgetDefinition.scope).toEqual(['tray']);
    expect(frameworkOpenDashboardWidgetDefinition.defaultSize).toBe('small');
    expect(frameworkOpenDashboardWidgetDefinition.supportedSizes).toEqual(['small']);
    expect(frameworkOpenDashboardWidgetDefinition.allowMultiple).toBe(false);
  });
});

describe('OpenDashboardWidget', () => {
  let bus: IMakaioBus;
  let subscriptions: Array<() => void>;
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    bus = createBusInstance();
    subscriptions = [];
    user = userEvent.setup();
  });

  afterEach(() => {
    subscriptions.forEach((unsubscribe) => unsubscribe());
  });

  it('renders the "Open Dashboard ↗" button', () => {
    renderOpenDashboardWidget(bus);
    expect(screen.getByRole('button', { name: 'Open Dashboard ↗' })).toBeInTheDocument();
  });

  it('clicking the button issues bus.request(HostSubjects.window.openDashboard, {})', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];

    subscriptions.push(
      bus.on(HostSubjects.window.openDashboard, (ctx) => {
        capturedRequests.push(ctx.payload);
        ctx.setResult({ windowId: 42 });
      }),
    );

    renderOpenDashboardWidget(bus);

    const button = screen.getByRole('button', { name: 'Open Dashboard ↗' });
    await user.click(button);

    await waitFor(() => {
      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0]).toEqual({});
    });
  });

  it('suppresses duplicate open-dashboard RPCs while a request is still in flight', async () => {
    const capturedRequests: Array<Record<string, unknown>> = [];
    const responseGate = createDeferred<{ windowId: number | null }>();

    subscriptions.push(
      bus.on(HostSubjects.window.openDashboard, async (ctx) => {
        capturedRequests.push(ctx.payload);
        await responseGate.promise.then((result) => {
          ctx.setResult(result);
        });
      }),
    );

    renderOpenDashboardWidget(bus);

    const button = screen.getByRole('button', { name: 'Open Dashboard ↗' });
    await user.dblClick(button);

    await waitFor(() => {
      expect(capturedRequests).toHaveLength(1);
      expect(button).toBeDisabled();
    });

    responseGate.resolve({ windowId: 42 });

    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
  });

  it('button is disabled when no bus context is available', () => {
    renderOpenDashboardWidgetWithoutBus();
    const button = screen.getByRole('button', { name: 'Open Dashboard ↗' });
    expect(button).toBeDisabled();
  });

  it('does not crash when the RPC returns windowId: null', async () => {
    subscriptions.push(
      bus.on(HostSubjects.window.openDashboard, (ctx) => {
        ctx.setResult({ windowId: null });
      }),
    );

    renderOpenDashboardWidget(bus);

    const button = screen.getByRole('button', { name: 'Open Dashboard ↗' });
    await user.click(button);

    // The widget should still be rendered after a null windowId response.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Open Dashboard ↗' })).toBeInTheDocument();
    });
  });

  it('calls console.error and re-enables the button when the RPC rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      subscriptions.push(
        bus.on(HostSubjects.window.openDashboard, () => {
          throw new Error('handler failure');
        }),
      );

      renderOpenDashboardWidget(bus);

      const button = screen.getByRole('button', { name: 'Open Dashboard ↗' });
      await user.click(button);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('[OpenDashboardWidget] Failed to open dashboard:', expect.any(Error));
        expect(screen.getByRole('button', { name: 'Open Dashboard ↗' })).not.toBeDisabled();
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
