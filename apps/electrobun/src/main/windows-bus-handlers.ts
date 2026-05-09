/**
 * Window management RPC handlers for the Electrobun desktop host.
 *
 * Keeps dashboard/focus routing testable without importing Bun-only modules
 * from the main composition root.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { HostSubjects } from '@makaio/contracts';
import type { WindowManagerState } from '@makaio/host-shared';

export interface ElectrobunWindowsBusHandlerDeps {
  /** Qualified registration ID for the framework dashboard shell. */
  dashboardRegistrationId: string;
  /**
   * Create a host window for the supplied registration.
   * @param registrationId - Qualified window registration ID to open.
   * @returns The created Electrobun window ID.
   */
  createWindow: (registrationId: string) => number;
  /**
   * Find an existing host window by registration ID.
   * @param registrationId - Qualified window registration ID to look up.
   * @returns Matching window state, or `undefined` when no matching window is open.
   */
  findWindow: (registrationId: string) => WindowManagerState | undefined;
  /**
   * Focus a specific host window.
   * @param windowId - Electrobun window ID to focus.
   * @returns Whether the window was focused.
   */
  focusWindow: (windowId: number) => boolean;
  /** Focus the most recent window and return its ID, or `null` when no window can be focused. */
  focusAnyWindow: () => number | null;
  /** Open the default framework shell window. */
  openDefaultWindow: () => number;
  /**
   * Called once before the first window is created when upgrading from
   * background-only mode to regular (visible) mode.
   *
   * Implementations should restore the Dock icon and clear the background flag.
   * Optional — omit when the app was not started in background mode.
   */
  onRestoreFromBackground?: () => void;
}

/**
 * Register dashboard and application focus RPC handlers.
 *
 * `dashboardRegistrationId` is intentionally injected instead of resolved from
 * `MAKAIO_INITIAL_WINDOW`: startup overrides are only for first-window launch
 * and must not redirect tray/dashboard affordances for the rest of the process.
 * @param bus - Bus instance used to register request handlers.
 * @param deps - Host window management dependencies.
 * @returns Cleanup callback that unregisters both handlers.
 */
export function registerElectrobunWindowsBusHandlers(
  bus: IMakaioBus,
  deps: ElectrobunWindowsBusHandlerDeps,
): () => void {
  const cleanupDashboard = bus.on(HostSubjects.window.openDashboard, (ctx) => {
    try {
      const existing = deps.findWindow(deps.dashboardRegistrationId);
      if (existing && deps.focusWindow(existing.windowId)) {
        ctx.setResult({ windowId: existing.windowId });
        return;
      }
      const windowId = deps.createWindow(deps.dashboardRegistrationId);
      ctx.setResult({ windowId });
    } catch (error) {
      console.error('[electrobun] Failed to open dashboard:', error instanceof Error ? error.message : error);
      ctx.setResult({ windowId: null });
    }
  });

  const cleanupFocus = bus.on(HostSubjects.app.focus, (ctx) => {
    try {
      // Restore, focus, and fallback window creation form one RPC operation:
      // host.app.focus must always resolve with the declared response shape.
      deps.onRestoreFromBackground?.();
      const focusedId = deps.focusAnyWindow();
      if (focusedId !== null) {
        ctx.setResult({ focused: true, windowId: focusedId });
        return;
      }
      const windowId = deps.openDefaultWindow();
      ctx.setResult({ focused: true, windowId });
    } catch (error) {
      console.error('[electrobun] Failed to focus app window:', error instanceof Error ? error.message : error);
      ctx.setResult({ focused: false, windowId: null });
    }
  });

  return () => {
    cleanupDashboard();
    cleanupFocus();
  };
}
