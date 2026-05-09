/**
 * Bus handler registration for window management subjects.
 *
 * Registers the `window.openDashboard` and `app.focus` RPC handlers.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { HostSubjects } from '@makaio/contracts';
import type { WindowState } from '@makaio/host-shared';

/**
 * Dependencies required by {@link registerWindowsBusHandlers}.
 *
 * Kept as a minimal interface so the handler can be unit-tested with plain
 * function stubs, without pulling in the real {@link WindowManager}.
 */
export interface WindowsBusHandlerDeps {
  /**
   * Qualified registration ID for the host shell's dashboard window.
   *
   * Injected by the composition root so this handler does not hardcode one
   * particular shell package's registration string.
   */
  dashboardRegistrationId: string;
  /**
   * Returns the Electron window ID of a new window created for the given
   * registration ID.
   *
   * Throws when the registration ID is not found in the window registry or
   * when the underlying `BrowserWindow` cannot be created. The handler catches
   * all throws and replies with `{ windowId: null }`.
   * @param registrationId - Qualified window registration ID to open.
   * @returns Electron `BrowserWindow.id` of the newly created window.
   */
  createWindow: (registrationId: string) => number;
  /**
   * Returns the {@link WindowState} of the currently open window with the
   * given registration ID, or `undefined` when no such window is open.
   *
   * Used to detect whether the dashboard window is already open before
   * deciding whether to focus an existing instance or create a new one.
   * @param registrationId - Qualified window registration ID to look up.
   * @returns Matching window state snapshot, or `undefined`.
   */
  findWindow: (registrationId: string) => WindowState | undefined;
  /**
   * Brings a window to the foreground by its Electron window ID.
   * @param windowId - Electron `BrowserWindow.id` to focus.
   * @returns `true` if the window was found and focused, `false` otherwise.
   */
  focusWindow: (windowId: number) => boolean;
  /** Focus the most recently active window. Returns the focused window ID, or null if no windows exist. */
  focusAnyWindow: () => number | null;
  /** Open the default shell window. Returns the window ID. */
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
 * Register the `window.openDashboard` and `app.focus` RPC handlers on the
 * given bus instance.
 *
 * `window.openDashboard` behaviour:
 * - If the dashboard window is already open, focuses it and returns its ID.
 *   If focusing fails (window disappeared between lookup and focus), falls
 *   through to create a new window.
 * - If the dashboard window is not open, creates a new one and returns its ID.
 * - Returns `{ windowId: null }` if the operation fails (e.g. window registry
 *   does not contain the dashboard registration).
 *
 * `app.focus` behaviour:
 * - If any window is already open, focuses the most recently active one and
 *   returns its ID.
 * - If no windows are open, opens the default shell window and returns its ID.
 * - Returns `{ focused: false, windowId: null }` if the operation fails.
 * @param bus - The bus instance to register the handlers on.
 * @param deps - Injectable window management functions.
 * @returns A cleanup function that unregisters all handlers.
 */
export function registerWindowsBusHandlers(bus: IMakaioBus, deps: WindowsBusHandlerDeps): () => void {
  const cleanupDashboard = bus.on(HostSubjects.window.openDashboard, (ctx) => {
    try {
      const existing = deps.findWindow(deps.dashboardRegistrationId);

      if (existing !== undefined && deps.focusWindow(existing.windowId)) {
        ctx.setResult({ windowId: existing.windowId });
        return;
      }

      const windowId = deps.createWindow(deps.dashboardRegistrationId);
      ctx.setResult({ windowId });
    } catch (error) {
      console.error(
        '[registerWindowsBusHandlers] Failed to open dashboard window:',
        error instanceof Error ? error.message : error,
      );
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
      console.error(
        '[registerWindowsBusHandlers] Failed to focus app window:',
        error instanceof Error ? error.message : error,
      );
      ctx.setResult({ focused: false, windowId: null });
    }
  });

  return () => {
    cleanupDashboard();
    cleanupFocus();
  };
}
