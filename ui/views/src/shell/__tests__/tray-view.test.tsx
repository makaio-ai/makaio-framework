// @vitest-environment jsdom
/**
 * TrayView integration tests.
 *
 * Verifies that the tray surface root component:
 * - Registers framework built-in widgets (status + open-dashboard) on mount.
 * - Renders both built-ins in the canvas in declaration order.
 * - Built-in widgets carry locked: true semantics (no remove button).
 * - A dynamically-registered third-party tray widget appears after the built-ins.
 * - Cleans up the registry on unmount (idempotent re-mount).
 *
 * ## Test harness contract
 *
 * `TrayView` registers the framework built-ins via the module-level
 * `widgetRegistry` singleton. Tests therefore:
 *   1. Clear the registry in `afterEach` to prevent cross-test contamination.
 *   2. Do NOT pre-register the built-ins — `TrayView` does that on mount.
 *   3. Wrap the component in `BusProvider` because `StatusWidget` calls
 *      `useBus()` which throws without a provider.
 */

import { createElement } from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { BusProvider, useTrayLayout } from '@makaio/ui-hooks';
import * as uiHooks from '@makaio/ui-hooks';
import { widgetRegistry } from '@makaio/ui-kernel';
import type { WidgetDefinition } from '@makaio/ui-kernel';
import {
  FRAMEWORK_TRAY_LOCKED_WIDGET_IDS,
  frameworkOpenDashboardWidgetDefinition,
  frameworkStatusWidgetDefinition,
} from '../../widgets/built-in/index.js';
import { TrayView } from '../tray-view.js';

/**
 * Minimal tray-scoped widget factory for test fixtures.
 * @param id - Unique widget identifier.
 * @returns A minimal WidgetDefinition with scope 'tray'.
 */
function makeTrayWidget(id: string): WidgetDefinition {
  return {
    component: () => createElement('div', { 'data-testid': `widget-${id}`, 'data-widget-id': id }),
    defaultSize: 'small',
    id,
    name: id,
    scope: 'tray',
    supportedSizes: ['small'],
  };
}

/**
 * Render TrayView inside a BusProvider backed by a concrete bus instance.
 * @returns Testing Library render result.
 */
function renderTrayView() {
  const bus = createBusInstance();
  return render(
    createElement(BusProvider, {
      bus,
      children: createElement(TrayView),
    }),
  );
}

/**
 * Create a deferred promise for async lifecycle tests.
 * @returns Promise plus explicit resolve/reject controls.
 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('TrayView', () => {
  beforeEach(() => {
    widgetRegistry.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    widgetRegistry.clear();
  });

  describe('framework built-in registration on mount', () => {
    it('registers the status widget on mount', async () => {
      renderTrayView();

      await waitFor(() => {
        expect(widgetRegistry.has(frameworkStatusWidgetDefinition.id)).toBe(true);
      });
    });

    it('registers the open-dashboard widget on mount', async () => {
      renderTrayView();

      await waitFor(() => {
        expect(widgetRegistry.has(frameworkOpenDashboardWidgetDefinition.id)).toBe(true);
      });
    });

    it('unregisters built-ins when the component unmounts', async () => {
      const { unmount } = renderTrayView();

      await waitFor(() => {
        expect(widgetRegistry.has(frameworkStatusWidgetDefinition.id)).toBe(true);
      });

      unmount();

      expect(widgetRegistry.has(frameworkStatusWidgetDefinition.id)).toBe(false);
      expect(widgetRegistry.has(frameworkOpenDashboardWidgetDefinition.id)).toBe(false);
    });
  });

  describe('framework built-in widgets rendered in the canvas', () => {
    it('renders the status widget', async () => {
      renderTrayView();

      // TrayView root renders with data-component="TrayView"
      await waitFor(() => {
        expect(document.querySelector('[data-component="TrayView"]')).not.toBeNull();
      });

      // StatusWidget uses data-component="StatusWidget"
      await waitFor(() => {
        expect(document.querySelector('[data-component="StatusWidget"]')).not.toBeNull();
      });
    });

    it('renders the open-dashboard widget', async () => {
      renderTrayView();

      await waitFor(() => {
        expect(document.querySelector('[data-component="OpenDashboardWidget"]')).not.toBeNull();
      });
    });

    it('renders the "Open Dashboard ↗" button', async () => {
      renderTrayView();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Open Dashboard ↗' })).toBeInTheDocument();
      });
    });
  });

  describe('locked placement semantics — no remove button', () => {
    it('does not show a remove button for the status widget (locked)', async () => {
      renderTrayView();

      await waitFor(() => {
        expect(document.querySelector('[data-component="StatusWidget"]')).not.toBeNull();
      });

      // TrayView always passes isEditing={false} so no remove buttons appear.
      // Even if edit mode were on, locked placements suppress the remove button.
      const removeButtons = document.querySelectorAll('[aria-label^="Remove widget"]');
      expect(removeButtons).toHaveLength(0);
    });

    it('does not show a remove button for the open-dashboard widget (locked)', async () => {
      renderTrayView();

      await waitFor(() => {
        expect(document.querySelector('[data-component="OpenDashboardWidget"]')).not.toBeNull();
      });

      const removeButtons = document.querySelectorAll('[aria-label^="Remove widget"]');
      expect(removeButtons).toHaveLength(0);
    });

    it('framework built-in placements carry locked: true regardless of edit state', () => {
      // Verifies the locked-first contract at the layout level: even if a parent
      // were to pass isEditing={true}, the locked flag on each placement would
      // suppress the remove button (enforced by WidgetGrid). We assert this via
      // useTrayLayout directly — the locked flag must be true for every built-in.
      widgetRegistry.register(frameworkStatusWidgetDefinition);
      widgetRegistry.register(frameworkOpenDashboardWidgetDefinition);

      const { result } = renderHook(() => useTrayLayout(FRAMEWORK_TRAY_LOCKED_WIDGET_IDS));
      const { placements } = result.current;

      for (const id of FRAMEWORK_TRAY_LOCKED_WIDGET_IDS) {
        const placement = placements.find((p) => p.widgetId === id);
        expect(placement, `placement for ${id} must exist`).toBeDefined();
        expect(placement!.locked, `placement for ${id} must be locked`).toBe(true);
      }
    });
  });

  describe('dynamic widget registration — registry reactivity', () => {
    it('renders a dynamically-registered tray-scope widget after registration', async () => {
      renderTrayView();

      // Wait for built-ins to appear first.
      await waitFor(() => {
        expect(document.querySelector('[data-component="OpenDashboardWidget"]')).not.toBeNull();
      });

      // Dynamically register a third-party tray widget.
      act(() => {
        widgetRegistry.register(makeTrayWidget('third-party'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('widget-third-party')).toBeInTheDocument();
      });
    });

    it('third-party tray widget is appended after the framework built-ins in tray layout order', async () => {
      renderTrayView();

      await waitFor(() => {
        expect(document.querySelector('[data-component="OpenDashboardWidget"]')).not.toBeNull();
      });

      act(() => {
        widgetRegistry.register(makeTrayWidget('late-arrival'));
      });

      await waitFor(() => {
        expect(screen.getByTestId('widget-late-arrival')).toBeInTheDocument();
      });

      const { result } = renderHook(() => useTrayLayout(FRAMEWORK_TRAY_LOCKED_WIDGET_IDS));
      expect(result.current.placements.map((placement) => placement.widgetId)).toEqual([
        frameworkStatusWidgetDefinition.id,
        frameworkOpenDashboardWidgetDefinition.id,
        'late-arrival',
      ]);
    });

    it('removing a registered tray widget removes it from the canvas', async () => {
      widgetRegistry.register(makeTrayWidget('removable'));

      renderTrayView();

      await waitFor(() => {
        expect(screen.getByTestId('widget-removable')).toBeInTheDocument();
      });

      act(() => {
        widgetRegistry.unregister('removable');
      });

      await waitFor(() => {
        expect(screen.queryByTestId('widget-removable')).toBeNull();
      });
    });
  });

  describe('idempotent re-mount', () => {
    it('re-mounting TrayView does not double-register the built-ins', async () => {
      const { unmount } = renderTrayView();

      await waitFor(() => {
        expect(widgetRegistry.has(frameworkStatusWidgetDefinition.id)).toBe(true);
      });

      unmount();

      // Second mount — registry was cleared by unmount cleanup. Built-ins
      // should be re-registered by the new mount.
      renderTrayView();

      await waitFor(() => {
        expect(widgetRegistry.has(frameworkStatusWidgetDefinition.id)).toBe(true);
        expect(widgetRegistry.has(frameworkOpenDashboardWidgetDefinition.id)).toBe(true);
      });
    });
  });

  describe('extension loader lifecycle', () => {
    it('runs stale extension cleanups if the view unmounts before loading resolves', async () => {
      const deferred = createDeferred<{
        cleanups: Array<() => void>;
        errorMessage: string | null;
        shell: null;
        state: 'ready';
      }>();
      const cleanup = vi.fn();

      vi.spyOn(uiHooks, 'loadExtensionBrowserContributions').mockReturnValueOnce(deferred.promise);

      const { unmount } = renderTrayView();
      unmount();

      deferred.resolve({
        cleanups: [cleanup],
        errorMessage: null,
        shell: null,
        state: 'ready',
      });

      await waitFor(() => {
        expect(cleanup).toHaveBeenCalledTimes(1);
      });
    });
  });
});
