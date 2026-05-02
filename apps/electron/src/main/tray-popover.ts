/**
 * Tray Popover — frameless SPA panel shown when the user clicks the tray
 * icon or presses the global hotkey (Alt+Cmd+M).
 *
 * Appears anchored to the cursor position (near the tray icon), just below
 * the menu bar. Dismisses on blur. Loads the renderer SPA with
 * `?surface=tray` so the React tree renders the tray canvas instead of the
 * full dashboard shell.
 *
 * Call {@link initTrayPopover} once from the Electron main bootstrap before
 * the first {@link toggleTrayPopover} invocation to supply the base and bus
 * URLs. All other behaviour — singleton enforcement, anchor positioning,
 * dismiss-on-blur, white-flash mitigation — is preserved from the previous
 * data-URL implementation.
 * @packageDocumentation
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, screen } from 'electron';
import { TRAY_WINDOW_HEIGHT_PX, TRAY_WINDOW_WIDTH_PX } from '@makaio/ui-kernel';

// ESM-compatible __dirname for preload path resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Gap between an anchor point and the rendered popover. */
const ANCHOR_GAP = 16;

/** Screen coordinates for the popover origin. */
interface PopoverPosition {
  /** Horizontal position in screen pixels. */
  x: number;
  /** Vertical position in screen pixels. */
  y: number;
}

/** Options for {@link toggleTrayPopover}. */
export interface TogglePopoverOptions {
  /** Optional screen anchor point (e.g. tray click position). */
  anchor?: PopoverPosition;
}

/** Module-level renderer config, supplied once via {@link initTrayPopover}. */
let rendererBaseUrl: string | null = null;
let rendererBusUrl: string | null = null;

/**
 * Initialise the tray popover renderer configuration.
 *
 * Must be called once from the Electron main bootstrap after the HTTP server
 * is listening and the base URL is known. Subsequent {@link toggleTrayPopover}
 * calls use these values to construct the SPA URL and inject bus config.
 * @param baseUrl - Web UI base URL (dev server or production `http://` path).
 * @param busUrl - WebSocket URL of the MakaioBus server.
 */
export function initTrayPopover(baseUrl: string, busUrl: string): void {
  rendererBaseUrl = baseUrl;
  rendererBusUrl = busUrl;
}

/** Singleton popover window, or null when hidden/destroyed. */
let popover: BrowserWindow | null = null;

/**
 * Guard flag — ensures the `before-quit` shutdown listener is registered at
 * most once across repeated {@link toggleTrayPopover} calls. Module-level so
 * it survives React StrictMode re-mounts and repeated toggle invocations.
 */
let beforeQuitListenerRegistered = false;

/**
 * Build the renderer URL for the tray surface.
 *
 * Appends `?surface=tray` so the React tree renders `TrayView` instead of
 * the dashboard shell. Query params are for both routing and DevTools
 * readability.
 * @param baseUrl - Web UI base URL.
 * @returns Fully constructed tray surface URL.
 */
function buildTrayUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('surface', 'tray');
  return url.toString();
}

/**
 * Compute the popover position.
 *
 * When an anchor point is provided (e.g. tray click coordinates), the popover
 * is centered on that point and rendered below it when space permits. When
 * omitted (e.g. hotkey), the popover is centered both horizontally and
 * vertically on the display containing the cursor.
 * @param anchor - Optional screen coordinates to anchor to
 * @returns Screen coordinates for the popover origin
 */
export function computePopoverBounds(anchor?: PopoverPosition): PopoverPosition {
  const cursorPoint = screen.getCursorScreenPoint();
  const ref = anchor ?? cursorPoint;
  const display = screen.getDisplayNearestPoint(ref);
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  if (anchor != null) {
    // Anchored call: center on the provided point and render below it while
    // keeping the popover inside the active display work area.
    const idealX = Math.round(anchor.x - TRAY_WINDOW_WIDTH_PX / 2);
    const idealY = Math.round(anchor.y + ANCHOR_GAP);
    return {
      x: Math.max(dx, Math.min(idealX, dx + dw - TRAY_WINDOW_WIDTH_PX)),
      y: Math.max(dy, Math.min(idealY, dy + dh - TRAY_WINDOW_HEIGHT_PX)),
    };
  }

  // Hotkey: center on display (both axes). Unlike the tray-click path
  // there is no meaningful anchor point, so centering gives the user a
  // consistent, screen-relative position regardless of tray location.
  return {
    x: Math.round(dx + (dw - TRAY_WINDOW_WIDTH_PX) / 2),
    y: Math.round(dy + (dh - TRAY_WINDOW_HEIGHT_PX) / 2),
  };
}

/**
 * Loads the tray SPA into the popover window with error cleanup.
 *
 * `BrowserWindow.loadURL` rejects on navigation failure. Without a catch
 * the rejection is unhandled, the window never shows, and the module-level
 * popover reference stays pinned to a dead window. On failure the window is
 * closed so the next toggle can recover cleanly.
 * @param popoverWindow - The popover window to load content into.
 * @param trayUrl - Fully-qualified URL of the tray SPA surface.
 */
function loadTraySurface(popoverWindow: BrowserWindow, trayUrl: string): void {
  void popoverWindow.loadURL(trayUrl).catch((error: unknown) => {
    console.error('[TrayPopover] Failed to load tray surface:', error);
    if (!popoverWindow.isDestroyed()) {
      popoverWindow.close();
    }
  });
}

/**
 * Show the tray popover idempotently.
 *
 * When a popover is already open (and not destroyed), returns `true`
 * immediately — the request is treated as a no-op so the popover is never
 * closed by a repeated show call.
 * When no popover is open, a new frameless BrowserWindow is created using the
 * same logic as {@link toggleTrayPopover}.
 *
 * Intended for bus `ui.popover.show` handlers where idempotency is required.
 * Tray-click and global hotkey continue to use {@link toggleTrayPopover}.
 *
 * Requires {@link initTrayPopover} to have been called first. When called
 * before initialisation, logs a warning and returns `false`.
 * @param options - Optional anchor position for popover placement.
 * @returns `true` when the popover is visible (new or already open), `false`
 *   on initialisation failure.
 */
export function showTrayPopover(options: TogglePopoverOptions = {}): boolean {
  if (popover != null && !popover.isDestroyed()) {
    // Already open — idempotent no-op, popover remains visible.
    return true;
  }
  return toggleTrayPopover(options);
}

/**
 * Toggle the tray popover: show it if hidden, hide it if visible.
 *
 * When a popover is already open, it is closed and the function returns
 * `false`. When no popover is open, a new frameless, transparent BrowserWindow
 * is created, positioned via {@link computePopoverBounds}, and shown.
 * The window loads the SPA with `?surface=tray` and auto-dismisses when it
 * loses focus.
 *
 * Requires {@link initTrayPopover} to have been called first. When called
 * before initialisation, logs a warning and returns `false`.
 * @param options - Optional anchor position for popover placement
 * @returns `true` when the popover is now shown, `false` when dismissed
 */
export function toggleTrayPopover(options: TogglePopoverOptions = {}): boolean {
  const openPopover = popover;
  if (openPopover != null && !openPopover.isDestroyed()) {
    openPopover.close();
    if (popover === openPopover) {
      popover = null;
    }
    return false;
  }

  if (rendererBaseUrl == null || rendererBusUrl == null) {
    console.warn('[TrayPopover] initTrayPopover() must be called before toggleTrayPopover()');
    return false;
  }

  // Register the app-level shutdown hook exactly once. On `before-quit` Electron
  // tears down windows and fires `closed`, but the order is not guaranteed for
  // every platform. This belt-and-suspenders path closes the popover and removes
  // the `browser-window-blur` listener so we never hold stale references.
  if (!beforeQuitListenerRegistered) {
    beforeQuitListenerRegistered = true;
    app.once('before-quit', () => {
      const currentPopover = popover;
      if (currentPopover != null && !currentPopover.isDestroyed()) {
        currentPopover.close();
      }
    });
  }

  const { x, y } = computePopoverBounds(options.anchor);
  const trayUrl = buildTrayUrl(rendererBaseUrl);
  const preloadPath = path.join(__dirname, 'preload.cjs');

  const popoverWindow = new BrowserWindow({
    x,
    y,
    width: TRAY_WINDOW_WIDTH_PX,
    height: TRAY_WINDOW_HEIGHT_PX,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Preload injects __MAKAIO_CONFIG__ so the renderer can connect to the
      // bus. The tray surface is a full SPA window and requires the same
      // bootstrap plumbing as regular managed windows.
      preload: preloadPath,
      additionalArguments: [
        `--makaio-bus-url=${rendererBusUrl}`,
        `--makaio-window-id=framework-shell:tray`,
        '--makaio-package-name=framework-shell',
        '--makaio-boot-complete',
      ],
    },
  });
  popover = popoverWindow;

  // Wait for the content to be parsed before showing to avoid a white/
  // transparent flash on the frameless window (macOS white-flash mitigation).
  popoverWindow.once('ready-to-show', () => {
    if (popover === popoverWindow && !popoverWindow.isDestroyed()) {
      popoverWindow.show();
    }
  });
  loadTraySurface(popoverWindow, trayUrl);

  // Dismiss when the popover loses focus or the app deactivates.
  // 'blur' alone doesn't fire reliably for frameless windows on macOS
  // when clicking on another app, so we also listen for app-level
  // browser-window-blur. That event fires for ANY window in the app —
  // we must filter to only dismiss when the *popover* is the window
  // that lost focus, otherwise opening the popover (which steals focus
  // from the main window) would immediately trigger a dismiss.
  const dismissPopover = (): void => {
    if (popover === popoverWindow && !popoverWindow.isDestroyed()) {
      popoverWindow.close();
    }
  };
  const dismissOnAppBlur = (_event: Electron.Event, blurredWindow: BrowserWindow): void => {
    if (blurredWindow === popoverWindow) {
      dismissPopover();
    }
  };
  popoverWindow.on('blur', dismissPopover);
  app.on('browser-window-blur', dismissOnAppBlur);

  popoverWindow.on('closed', () => {
    app.off('browser-window-blur', dismissOnAppBlur);
    if (popover === popoverWindow) {
      popover = null;
    }
  });

  return true;
}
