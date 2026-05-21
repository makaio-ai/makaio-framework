/**
 * Makaio Desktop - Electrobun Window Manager
 *
 * Manages Electrobun window creation, lifecycle, and registry. Window
 * configuration is driven by {@link WindowRegistry} populated from package
 * manifests at boot, replacing the former static `WindowType` enum approach.
 *
 * Singleton enforcement is derived from {@link WindowRegistration.singleton}.
 * Tray-popover windows created directly through the WindowManager (rather than
 * via the dedicated `tray-popover.ts` module) are positioned near the system
 * tray icon area using the primary display's work area and closed on blur.
 *
 * Key differences from the Electron window manager:
 * - Config is injected via URL query parameters (no preload/contextBridge).
 * - `isVisible`, `isFocused`, `isDestroyed` are tracked via event listeners
 *   because Electrobun does not expose synchronous state query methods.
 * - `Screen.getPrimaryDisplay()` is used for tray-popover fallback positioning;
 *   `getDisplayNearestPoint` is not available (primary display approximation).
 * - Tray-popover windows are closed (not minimised) on blur so the singleton
 *   slot is released and a fresh window is created on the next tray click.
 * - Window IDs are Electrobun-assigned integers, compatible with the registry
 *   key used by the Electron manager.
 *
 * This module is intentionally decoupled from the bus — callers (main.ts)
 * own event emission so WindowManager stays testable and bus-agnostic.
 */

import { BrowserWindow, Screen } from 'electrobun/bun';
import {
  assertNoReservedWindowParams,
  buildRendererLaunchUrl,
  createRendererLaunchConfig,
  type RendererLaunchConfig,
  type WindowManagerState,
  type WindowSessionLiveWindow,
} from '@makaio/host-shared';
import type { WindowRegistry, WindowRegistration } from '@makaio/kernel';

const RESERVED_BOOTSTRAP_QUERY_KEYS: ReadonlySet<string> = new Set(['app', 'window', 'busUrl', 'bootComplete']);

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * Window frame bounds in screen coordinates.
 */
export interface WindowFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Live window wrapper that tracks Electrobun window state in memory.
 *
 * Electrobun does not expose synchronous `isVisible()`, `isFocused()`, or
 * `isDestroyed()` methods, so this proxy mirrors the last known state derived
 * from event listeners attached at window creation time.
 *
 * Electrobun emits no `minimize` event, so callers must use {@link minimize}
 * on this proxy (rather than the raw `BrowserWindow`) to keep visible-state
 * tracking accurate.
 */
export interface ElectrobunWindowProxy extends WindowSessionLiveWindow {
  /** The underlying Electrobun BrowserWindow instance. */
  readonly browserWindow: BrowserWindow;
  /** Returns `true` when the window has received the `close` event. */
  isDestroyed(): boolean;
  /** Returns `true` when the window currently has OS focus. */
  isFocused(): boolean;
  /** Returns `true` when the window is currently visible. */
  isVisible(): boolean;
  /**
   * Minimise the window and mark it as not visible.
   *
   * Electrobun does not emit a `minimize` event, so calling this method is the
   * only way to keep `isVisible()` accurate when the window is programmatically
   * minimised. Use this instead of `browserWindow.minimize()` directly.
   */
  minimize(): void;
  /** Returns the current window frame as {@link WindowFrame}. */
  getBounds(): WindowFrame;
}

/**
 * Internal registry entry tracking a live window together with its metadata.
 * Carries the {@link ElectrobunWindowProxy} alongside the state fields exposed
 * via the bus-facing {@link WindowManagerState} contract.
 */
export interface WindowEntry {
  /** The Electrobun window proxy providing state queries and bounds access. */
  readonly win: ElectrobunWindowProxy;
  /** Qualified window registration ID: `{packageName}:{windowId}`. */
  readonly registrationId: string;
  /**
   * Window-specific context parameters declared by the manifest
   * (e.g. `{ projectId: 'abc-123' }`).
   */
  readonly params?: Record<string, string>;
  /** Display label shown to the user. */
  readonly label?: string;
}

/**
 * Options passed to {@link WindowManager.createWindow}.
 */
export interface CreateWindowOptions {
  /**
   * Qualified window registration ID: `{packageName}:{windowId}`.
   *
   * Must match a registration in the {@link WindowRegistry} supplied at
   * construction time.
   */
  readonly registrationId: string;
  /**
   * Window-specific context parameters declared by the manifest
   * (e.g. `{ projectId: 'abc-123' }`).
   */
  readonly params?: Record<string, string>;
}

/**
 * Result of {@link WindowManager.createWindow}.
 */
export interface CreateWindowResult {
  /** Window ID of the created or reused window. */
  readonly windowId: number;
  /** `true` only when a new BrowserWindow instance was created. */
  readonly isNew: boolean;
}

export type { WindowManagerState } from '@makaio/host-shared';

// ── WindowManager options ──────────────────────────────────────────────────────

/**
 * Construction options for {@link WindowManager}.
 */
export interface WindowManagerOptions {
  /**
   * TCP port the Bun HTTP server is listening on.
   * Used to construct the renderer URL and bus WebSocket URL.
   */
  readonly port: number;
  /** When `true`, DevTools are opened automatically on each new window. */
  readonly isDev: boolean;
  /**
   * Window registry populated from package manifests during boot.
   *
   * Used to look up {@link WindowRegistration} by qualified ID when creating
   * windows. The registry is queried at creation time — registrations added
   * after construction are immediately visible.
   */
  readonly windowRegistry: WindowRegistry;
}

// ── ElectrobunWindowProxy implementation ──────────────────────────────────────

/**
 * Create a stateful proxy around an Electrobun BrowserWindow.
 *
 * Subscribes to `focus` and `close` events to track visibility and focus
 * state, since Electrobun does not provide synchronous query methods for these.
 * Electrobun does not emit a `minimize` event, so minimisation must go through
 * {@link ElectrobunWindowProxy.minimize} to keep visible-state accurate.
 *
 * State transitions:
 * - `focus` event  → `visible = true`, `focused = true`
 * - `blur` event   → `focused = false`
 * - `close` event  → `visible = false`, `focused = false`, `destroyed = true`
 * - `minimize()`   → `visible = false` (no OS event available)
 *
 * Initial state: `visible = true`, `focused = false`, `destroyed = false`.
 * @param win - The Electrobun BrowserWindow to wrap.
 * @returns A proxy object satisfying {@link ElectrobunWindowProxy}.
 */
function createWindowProxy(win: BrowserWindow): ElectrobunWindowProxy {
  let visible = true;
  let focused = false;
  let destroyed = false;

  // Track focus/blur via window-specific event names (e.g. `focus-3`, `blur-3`).
  win.on(`focus`, () => {
    focused = true;
    visible = true;
  });
  win.on(`blur`, () => {
    focused = false;
  });
  // The `close` event fires when the window is fully destroyed.
  win.on(`close`, () => {
    destroyed = true;
    visible = false;
    focused = false;
  });

  return {
    browserWindow: win,
    isDestroyed: () => destroyed,
    isFocused: () => focused,
    isVisible: () => visible,
    minimize: () => {
      visible = false;
      win.minimize();
    },
    getBounds: () => win.getFrame(),
  };
}

// ── WindowManager ──────────────────────────────────────────────────────────────

/**
 * Manages all Electrobun windows for the Makaio desktop application.
 *
 * Responsibilities:
 * - Create BrowserWindows driven by {@link WindowRegistration} from the package registry
 * - Enforce singleton constraints from `registration.singleton`
 * - Position tray-popover windows near the system tray and hide on blur
 * - Maintain a live registry of all open windows
 * - Expose query and mutation helpers (focus, list, get, updateLabel)
 *
 * This class is intentionally bus-agnostic. Callers own event emission so
 * the manager stays independently testable.
 * @example
 * ```typescript
 * const manager = new WindowManager({
 *   port: 6252,
 *   isDev: true,
 *   windowRegistry,
 * });
 *
 * const { windowId } = manager.createWindow({
 *   registrationId: 'my-ext.editor:main',
 *   params: { projectId: 'proj-1' },
 * });
 * manager.focusWindow(windowId);
 * const states = manager.listWindows();
 * ```
 */
export class WindowManager {
  /** Live registry of all open windows, keyed by Electrobun window ID. */
  private readonly registry = new Map<number, WindowEntry>();

  /** TCP port the Bun HTTP server is listening on. */
  private readonly port: number;

  /** Whether to open DevTools on each new window. */
  private readonly isDev: boolean;

  /** Window registry populated from package manifests during boot. */
  private readonly windowRegistry: WindowRegistry;

  /**
   * Whether service boot has completed. When true, new windows receive a
   * `bootComplete=1` query param so the renderer can skip the
   * `waitForServiceBoot` RPC and mount React immediately.
   */
  private bootComplete = false;

  /**
   * @param options - Window manager construction options
   */
  public constructor(options: WindowManagerOptions) {
    this.port = options.port;
    this.isDev = options.isDev;
    this.windowRegistry = options.windowRegistry;
  }

  /**
   * Mark service boot as complete so subsequent windows skip the boot wait.
   *
   * Called by the main process when `KernelSubjects.ready` fires. Windows
   * created after this call receive `bootComplete=1` in their URL params.
   */
  public setBootComplete(): void {
    this.bootComplete = true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Bring a window to the foreground.
   * @param win - The Electrobun window proxy to focus
   */
  private bringToFront(win: ElectrobunWindowProxy): void {
    const browserWindow = win.browserWindow;
    if (browserWindow.isMinimized()) {
      browserWindow.unminimize();
    }
    browserWindow.show();
    browserWindow.focus();
  }

  /**
   * Create a new BrowserWindow for the given registration ID, or focus the
   * existing instance for singleton registrations.
   *
   * Tray-popover windows are positioned adjacent to the system tray icon area
   * and automatically hidden when they lose focus (`dismissOnBlur`).
   * @param options - Window creation options
   * @returns Window ID plus a flag indicating whether a new window was created
   * @throws If the `registrationId` is not found in the window registry
   */
  public createWindow(options: CreateWindowOptions): CreateWindowResult {
    const { registrationId, params } = options;
    const registration = this.windowRegistry.get(registrationId);
    if (registration == null) {
      throw new Error(`[WindowManager] Unknown window registration: "${registrationId}"`);
    }

    // Singleton guard: return existing window ID if one is already live
    if (registration.singleton) {
      const existing = this.findEntryByRegistrationId(registrationId);
      if (existing != null) {
        this.bringToFront(existing.win);
        return { windowId: existing.win.browserWindow.id, isNew: false };
      }
    }

    // Electrobun does not use a preload/contextBridge mechanism; the host
    // serializes the shared renderer launch config into URL query parameters.
    const url = this.buildUrl(registration, params ?? {});

    const win = new BrowserWindow({
      title: registration.displayName,
      frame: {
        x: 0,
        y: 0,
        width: registration.width,
        height: registration.height,
      },
      url,
      titleBarStyle: registration.frame === false ? 'hidden' : 'default',
    });

    const proxy = createWindowProxy(win);
    const windowId = win.id;

    const entry: WindowEntry = { win: proxy, registrationId, params, label: registration.displayName };
    this.registry.set(windowId, entry);

    // Tray-popover: position near the tray icon area and close on blur.
    // `positionTrayPopover` uses the primary display work area; for
    // tray-click-anchored positioning, `tray-popover.ts` handles it before
    // the window is created via `toggleTrayPopover`.
    if (registration.style === 'tray-popover') {
      this.positionTrayPopover(win, registration.width, registration.height);
      if (registration.dismissOnBlur) {
        win.on(`blur`, () => {
          if (!proxy.isDestroyed()) {
            // Close (not minimise) so that the BrowserWindowMap entry and the
            // singleton registry slot are released. The next tray click creates
            // a fresh window. Electrobun has no hide() API; close() is the
            // correct dismiss-on-blur mechanism for popover windows.
            win.close();
          }
        });
      }
    }

    if (this.isDev) {
      win.webview?.openDevTools();
    }

    // Clean up registry on close (no bus interaction — callers handle that)
    win.on(`close`, () => {
      this.registry.delete(windowId);
    });

    console.info(`[WindowManager] Loading URL: ${url}`);

    return { windowId, isNew: true };
  }

  /**
   * Focus a specific window, or the most recently created window if no ID
   * is provided.
   * @param windowId - Window ID to focus; omit to focus most recent
   * @returns `true` if a window was focused, `false` if no matching window exists
   */
  public focusWindow(windowId?: number): boolean {
    if (windowId != null) {
      const entry = this.registry.get(windowId);
      if (entry == null) return false;
      this.bringToFront(entry.win);
      return true;
    }

    // No specific ID — focus the most recently created managed window
    const entries = Array.from(this.registry.values());
    if (entries.length === 0) return false;
    const last = entries[entries.length - 1];
    this.bringToFront(last.win);
    return true;
  }

  /**
   * Return a snapshot of all currently open windows.
   * @returns Array of {@link WindowManagerState} snapshots, one per open window
   */
  public listWindows(): WindowManagerState[] {
    return Array.from(this.registry.entries()).map(([id, entry]) => this.toState(id, entry));
  }

  /**
   * Returns a snapshot of a window entry by its ID.
   * @param windowId - The window ID
   * @returns A readonly snapshot, or undefined if not found
   */
  public getWindow(windowId: number): Readonly<WindowEntry> | undefined {
    const entry = this.registry.get(windowId);
    if (!entry) return undefined;
    return { ...entry };
  }

  /**
   * Update the display label for a window.
   *
   * Replaces the registry entry with a new snapshot carrying the updated label.
   * @param windowId - Window ID
   * @param label - New display label (project name, chat preview, etc.)
   * @returns `true` if the window was found and updated, `false` otherwise
   */
  public updateLabel(windowId: number, label: string): boolean {
    const entry = this.registry.get(windowId);
    if (entry == null) return false;
    this.registry.set(windowId, { ...entry, label });
    return true;
  }

  /**
   * Show all previously hidden managed windows.
   *
   * Reuses the shared bring-to-front path so show/minimise restoration stays
   * consistent with singleton reuse and focused-window activation.
   *
   * When multiple windows are managed this focuses them in registry order and
   * leaves the last window frontmost. That is intentional: `ui.popover.show`
   * is the "make the desktop surface visible again" seam for this host.
   */
  public showAll(): void {
    for (const entry of this.registry.values()) {
      if (!entry.win.isDestroyed()) {
        this.bringToFront(entry.win);
      }
    }
  }

  /**
   * Close all managed windows.
   *
   * Called during graceful shutdown so native Electrobun render processes are
   * torn down before the Node main process exits. Without this, render
   * processes survive as orphans because `process.exit()` does not propagate
   * to Electrobun's native window host.
   */
  public closeAllWindows(): void {
    for (const [, entry] of this.registry) {
      if (!entry.win.isDestroyed()) {
        entry.win.browserWindow.close();
      }
    }
  }

  /**
   * Find the first open window with a given registration ID.
   * @param registrationId - Qualified window registration ID to look up.
   * @returns State snapshot of the matching window, or `undefined` if not found.
   */
  public findByRegistrationId(registrationId: string): WindowManagerState | undefined {
    for (const [id, entry] of this.registry.entries()) {
      if (entry.registrationId === registrationId) return this.toState(id, entry);
    }
    return undefined;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Find the first live window with a given registration ID, or `undefined`
   * if none exists.
   * @param registrationId - The qualified window registration ID to search for
   * @returns Matching {@link WindowEntry} or `undefined`
   */
  private findEntryByRegistrationId(registrationId: string): WindowEntry | undefined {
    for (const entry of this.registry.values()) {
      if (entry.registrationId === registrationId) return entry;
    }
    return undefined;
  }

  /**
   * Position a tray-popover window near the bottom-right corner of the
   * primary display's work area.
   *
   * Uses `Screen.getPrimaryDisplay()` so the placement respects the actual
   * display dimensions. A small margin keeps the window away from the
   * screen edge. The tray icon position is not available at this call site;
   * for tray-click-anchored positioning, the caller should use
   * `tray-popover.ts:computePopoverBounds` instead.
   * @param win - The BrowserWindow to position.
   * @param width - Window width in pixels.
   * @param height - Window height in pixels.
   */
  private positionTrayPopover(win: BrowserWindow, width: number, height: number): void {
    const margin = 8;
    const display = Screen.getPrimaryDisplay();
    const { x: dx, y: dy, width: dw, height: dh } = display.workArea;

    const x = dx + dw - width - margin;
    const y = dy + dh - height - margin;

    win.setPosition(Math.round(x), Math.round(y));
  }

  /**
   * Construct the web UI URL for a window registration.
   *
   * Pattern: `http://127.0.0.1:<port>/?app={packageName}&window={qualifiedId}&busUrl=...&bootComplete=...`
   *
   * Config is injected via query parameters because Electrobun does not use
   * a preload/contextBridge mechanism. The renderer reads config from
   * `window.location.search` on mount.
   *
   * Keeping package names out of the HTTP path avoids static file servers
   * treating dotted package names as asset requests instead of serving the
   * SPA HTML fallback.
   * @param registration - Window registration providing packageName and windowId
   * @param params - Context parameters appended as query string entries
   * @returns Fully constructed URL string
   */
  private createLaunchConfig(
    registration: Pick<WindowRegistration, 'packageName' | 'qualifiedId'>,
    params: Readonly<Record<string, string>>,
  ): RendererLaunchConfig {
    assertNoReservedWindowParams(params, RESERVED_BOOTSTRAP_QUERY_KEYS, 'Electrobun');

    return createRendererLaunchConfig({
      baseUrl: `http://127.0.0.1:${this.port}/`,
      busUrl: `ws://127.0.0.1:${this.port}/bus`,
      registration,
      params,
      bootComplete: this.bootComplete,
    });
  }

  /**
   * Construct the web UI URL for a window registration.
   * @param registration - Window registration providing packageName and windowId.
   * @param params - Context parameters appended as query string entries.
   * @returns Fully constructed URL string.
   */
  private buildUrl(registration: WindowRegistration, params: Readonly<Record<string, string>>): string {
    return buildRendererLaunchUrl(this.createLaunchConfig(registration, params), {
      includeBootComplete: true,
      includeBusUrl: true,
    });
  }

  /**
   * Convert a registry entry to a {@link WindowManagerState} snapshot.
   * @param windowId - Window ID
   * @param entry - The registry entry to convert
   * @returns Immutable state snapshot
   */
  private toState(windowId: number, entry: WindowEntry): WindowManagerState {
    return {
      windowId,
      registrationId: entry.registrationId,
      params: entry.params,
      label: entry.label,
      visible: entry.win.isVisible(),
      focused: entry.win.isFocused(),
    };
  }
}
