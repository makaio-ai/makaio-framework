/**
 * Tray Popover — frameless SPA panel shown when the user clicks the tray icon
 * or presses the global hotkey (Alt+Cmd+M).
 *
 * Mirrors `framework/apps/electron/src/main/tray-popover.ts` for the
 * Electrobun host. Key differences from the Electron implementation:
 * - Config is injected via URL query parameters (no preload/contextBridge).
 * - `hidden: true` in the constructor suppresses the initial `showWindow` call;
 *   `win.show()` (which calls the native `showWindow`/`focusWindow` FFI) is
 *   invoked explicitly once the webview emits `dom-ready`.
 * - The popover is closed (not minimised) on blur so that `BrowserWindowMap`
 *   is cleaned up and the singleton reference is released cleanly.
 * - Display-aware positioning uses `Screen.getPrimaryDisplay()` because
 *   Electrobun does not expose `getDisplayNearestPoint`; the primary display
 *   is a reasonable proxy for single-monitor setups and the common macOS case.
 * - Dismiss-on-blur is handled via the window-level `blur` event (Electrobun
 *   does not fire app-level "browser-window-blur" equivalents).
 *
 * Call {@link initTrayPopover} once from the Electrobun main bootstrap before
 * the first {@link toggleTrayPopover} invocation to supply the base and bus
 * URLs.
 * @packageDocumentation
 */

import { BrowserWindow, Screen } from 'electrobun/bun';
import type { Rectangle } from 'electrobun/bun';
import { TRAY_WINDOW_HEIGHT_PX, TRAY_WINDOW_WIDTH_PX } from '@makaio/ui-kernel';

/** Gap between the tray anchor point and the popover top edge. */
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
  /** Optional screen anchor point derived from the tray icon bounds. */
  anchor?: PopoverPosition;
}

/** Module-level renderer config, supplied once via {@link initTrayPopover}. */
let rendererBaseUrl: string | null = null;
let rendererBusUrl: string | null = null;

/**
 * Initialise the tray popover renderer configuration.
 *
 * Must be called once from the Electrobun main bootstrap after the HTTP server
 * is listening and the base URL is known. Subsequent {@link toggleTrayPopover}
 * calls use these values to construct the SPA URL and inject bus config.
 * @param baseUrl - Web UI base URL (Vite dev server or production `http://` path).
 * @param busUrl - WebSocket URL of the MakaioBus server.
 */
export function initTrayPopover(baseUrl: string, busUrl: string): void {
  rendererBaseUrl = baseUrl;
  rendererBusUrl = busUrl;
}

/** Singleton popover window, or null when closed/destroyed. */
let popover: BrowserWindow | null = null;

/**
 * Build the renderer URL for the tray surface.
 *
 * Appends `?surface=tray` so the React tree renders `TrayView` instead of the
 * dashboard shell. Config is passed via query params because Electrobun does
 * not use a preload/contextBridge mechanism.
 * @param baseUrl - Web UI base URL.
 * @param busUrl - WebSocket URL for the MakaioBus.
 * @returns Fully constructed tray surface URL.
 */
function buildTrayUrl(baseUrl: string, busUrl: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('surface', 'tray');
  url.searchParams.set('busUrl', busUrl);
  url.searchParams.set('bootComplete', '1');
  return url.toString();
}

/**
 * Compute the popover position.
 *
 * When an anchor point is provided (e.g. tray icon centre), the popover is
 * centred on that x-coordinate and rendered below it. When omitted (e.g.
 * hotkey), the popover is centred on the primary display.
 *
 * Electrobun does not expose `screen.getDisplayNearestPoint()`, so we fall
 * back to the primary display in both paths. This is an acceptable approximation
 * for the macOS single-display case (the most common tray scenario).
 * @param anchor - Optional screen coordinates to anchor the popover to.
 * @returns Screen coordinates for the popover top-left corner.
 */
export function computePopoverBounds(anchor?: PopoverPosition): PopoverPosition {
  const display = Screen.getPrimaryDisplay();
  const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

  if (anchor != null) {
    // Anchored: centre on the provided x-coordinate and render below it,
    // clamped to the primary display work area.
    const idealX = Math.round(anchor.x - TRAY_WINDOW_WIDTH_PX / 2);
    const idealY = Math.round(anchor.y + ANCHOR_GAP);
    return {
      x: Math.max(dx, Math.min(idealX, dx + dw - TRAY_WINDOW_WIDTH_PX)),
      y: Math.max(dy, Math.min(idealY, dy + dh - TRAY_WINDOW_HEIGHT_PX)),
    };
  }

  // Hotkey path: centre on primary display.
  return {
    x: Math.round(dx + (dw - TRAY_WINDOW_WIDTH_PX) / 2),
    y: Math.round(dy + (dh - TRAY_WINDOW_HEIGHT_PX) / 2),
  };
}

/**
 * Show the tray popover idempotently.
 *
 * When a popover is already open, returns `true` immediately — the request is
 * treated as a no-op so the popover is never closed by a repeated show call.
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
  if (popover != null) {
    // Already open — idempotent no-op, popover remains visible.
    return true;
  }
  return toggleTrayPopover(options);
}

/**
 * Toggle the tray popover: show it if hidden, close it if visible.
 *
 * When a popover is already open, it is closed and the function returns
 * `false`. When no popover is open, a new frameless BrowserWindow is created,
 * positioned via {@link computePopoverBounds}, started hidden (to avoid a
 * visible-before-content flash), and shown once the webview fires `dom-ready`.
 * The window auto-dismisses when it loses focus.
 *
 * Requires {@link initTrayPopover} to have been called first. When called
 * before initialisation, logs a warning and returns `false`.
 * @param options - Optional anchor position for popover placement.
 * @returns `true` when the popover is now shown, `false` when dismissed.
 */
export function toggleTrayPopover(options: TogglePopoverOptions = {}): boolean {
  const openPopover = popover;
  if (openPopover != null) {
    openPopover.close();
    // Cleanup is handled in the `close` event listener below; reset eagerly so
    // a rapid double-click does not open a second window.
    if (popover === openPopover) {
      popover = null;
    }
    return false;
  }

  if (rendererBaseUrl == null || rendererBusUrl == null) {
    console.warn('[TrayPopover] initTrayPopover() must be called before toggleTrayPopover()');
    return false;
  }

  const { x, y } = computePopoverBounds(options.anchor);
  const trayUrl = buildTrayUrl(rendererBaseUrl, rendererBusUrl);

  // `hidden: true` suppresses the native showWindow call inside the Electrobun
  // BrowserWindow constructor so the window is created off-screen. We show it
  // explicitly once `dom-ready` fires to avoid a blank-frame flash.
  const popoverWindow = new BrowserWindow({
    url: trayUrl,
    frame: {
      x,
      y,
      width: TRAY_WINDOW_WIDTH_PX,
      height: TRAY_WINDOW_HEIGHT_PX,
    },
    titleBarStyle: 'hidden',
    transparent: true,
    hidden: true,
  });
  popover = popoverWindow;

  // Show once the webview has finished its initial load to avoid white-flash.
  // Electrobun fires `dom-ready` from the webview via the event bridge.
  popoverWindow.on('dom-ready', () => {
    if (popover === popoverWindow) {
      popoverWindow.show();
    }
  });

  // Dismiss when focus leaves the popover. Closing (not minimising) releases
  // the BrowserWindowMap entry and the module-level singleton reference.
  const dismissPopover = (): void => {
    if (popover === popoverWindow) {
      popoverWindow.close();
    }
  };
  popoverWindow.on('blur', dismissPopover);

  // Release the singleton reference when the window closes so that the next
  // toggle creates a fresh window.
  popoverWindow.on('close', () => {
    if (popover === popoverWindow) {
      popover = null;
    }
  });

  return true;
}

/**
 * Derive a tray anchor point from the native tray icon bounds.
 *
 * Computes the bottom-centre of the tray icon rectangle so
 * {@link computePopoverBounds} can render the popover just below it.
 * @param trayBounds - Rectangle returned by `Tray.getBounds()`.
 * @returns Screen coordinates for the anchor point.
 */
export function anchorFromTrayBounds(trayBounds: Rectangle): PopoverPosition {
  return {
    x: Math.round(trayBounds.x + trayBounds.width / 2),
    y: Math.round(trayBounds.y + trayBounds.height),
  };
}
