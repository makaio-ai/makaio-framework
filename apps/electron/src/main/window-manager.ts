/**
 * Makaio Desktop - Window Manager
 *
 * Manages Electron window creation, lifecycle, and registry. Window
 * configuration is driven by {@link WindowRegistry} populated from package
 * manifests at boot, replacing the former static `WindowType` enum approach.
 *
 * Singleton enforcement is derived from {@link WindowRegistration.singleton}.
 * Tray-popover windows are positioned near the system tray icon and dismiss
 * on blur.
 *
 * This module is intentionally decoupled from the bus — callers (main.ts)
 * own event emission so WindowManager stays testable and bus-agnostic.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { app, BrowserWindow, screen } from 'electron';
import {
  assertNoReservedWindowParams,
  buildRendererLaunchUrl,
  createRendererLaunchConfig,
  encodeRendererParams,
  type RendererLaunchConfig,
  type WindowManagerState,
} from '@makaio/host-shared';
import type { WindowRegistry, WindowRegistration } from '@makaio/kernel';
import { createRendererConsoleEvent, logRendererConsoleEvent } from './renderer-console.js';

const RESERVED_BOOTSTRAP_QUERY_KEYS: ReadonlySet<string> = new Set(['app', 'window']);

// ESM-compatible __dirname for preload path resolution
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Public types ───────────────────────────────────────────────────────────────

/**
 * Internal registry entry tracking a live window together with its metadata.
 * Carries the BrowserWindow instance alongside the state fields exposed via
 * the bus-facing {@link WindowManagerState} contract.
 */
export interface WindowEntry {
  /** The Electron BrowserWindow instance. */
  readonly win: BrowserWindow;
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
  /** Electron window ID of the created or reused window. */
  readonly windowId: number;
  /** `true` only when a new BrowserWindow instance was created. */
  readonly isNew: boolean;
}

export type { WindowManagerState } from '@makaio/host-shared';

// ── WindowManager ──────────────────────────────────────────────────────────────

/**
 * Construction options for {@link WindowManager}.
 */
export interface WindowManagerOptions {
  /** Web UI base URL — dev server URL (e.g. `http://localhost:6252`) or prod `file://` path. */
  readonly baseUrl: string;
  /** WebSocket URL of the MakaioBus server, injected into renderer via preload. */
  readonly busUrl: string;
  /** When `true`, DevTools are opened automatically on each new window. */
  readonly isDev: boolean;
  /** Absolute path to the application icon file (`.png` on macOS/Linux, `.ico` on Windows). */
  readonly iconPath: string;
  /**
   * Window registry populated from package manifests during boot.
   *
   * Used to look up {@link WindowRegistration} by qualified ID when creating
   * windows. The registry is queried at creation time — registrations added
   * after construction are immediately visible.
   */
  readonly windowRegistry: WindowRegistry;
}

/**
 * Manages all Electron windows for the Makaio desktop application.
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
 *   baseUrl: 'http://localhost:6252',
 *   busUrl: 'ws://localhost:6252/bus',
 *   isDev: true,
 *   iconPath: '/path/to/icon.png',
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
  /** Live registry of all open windows, keyed by Electron window ID. */
  private readonly registry = new Map<number, WindowEntry>();

  /** Web UI base URL (http URL in dev; file:// path in production). */
  private readonly baseUrl: string;

  /** WebSocket URL of the MakaioBus server, passed to each renderer via preload. */
  private readonly busUrl: string;

  /** Whether to open DevTools on each new window. */
  private readonly isDev: boolean;

  /** Absolute path to the application icon file. */
  private readonly iconPath: string;

  /** Window registry populated from package manifests during boot. */
  private readonly windowRegistry: WindowRegistry;

  /**
   * Whether service boot has completed. When true, new windows receive a
   * `--makaio-boot-complete` flag via `additionalArguments` so the renderer
   * can skip the `waitForServiceBoot` RPC and mount React immediately.
   */
  private bootComplete = false;

  /**
   * @param options - Window manager construction options
   */
  public constructor(options: WindowManagerOptions) {
    this.baseUrl = options.baseUrl;
    this.busUrl = options.busUrl;
    this.isDev = options.isDev;
    this.iconPath = options.iconPath;
    this.windowRegistry = options.windowRegistry;
  }

  /**
   * Mark service boot as complete so subsequent windows skip the boot wait.
   *
   * Called by the main process when `BootSubjects.complete` or
   * `KernelSubjects.ready` fires. Windows created after this call receive
   * `--makaio-boot-complete` in their `additionalArguments`.
   */
  public setBootComplete(): void {
    this.bootComplete = true;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Activate the Electron app and bring a window to the foreground.
   *
   * `app.focus({ steal: true })` is needed on macOS to pull the app above
   * other windows when the activation originates from a non-Electron context
   * (e.g. tray click, global hotkey).
   * @param win - Window to show and focus
   */
  private bringToFront(win: BrowserWindow): void {
    app.focus({ steal: true });
    win.show();
    win.focus();
  }

  /**
   * Wire renderer lifecycle logging and failure recovery for a BrowserWindow.
   * @param win - Window whose webContents should be observed.
   * @param url - Renderer URL being loaded into the window.
   */
  private attachWindowContentObservers(win: BrowserWindow, url: string): void {
    const showOnFailure = (): void => {
      if (!win.isDestroyed() && !win.isVisible()) {
        win.show();
      }
    };

    win.webContents.on('did-finish-load', () => {
      console.info(`[WindowManager] Loaded URL: ${url}`);
    });
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[WindowManager] Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
      showOnFailure();
    });
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      logRendererConsoleEvent(createRendererConsoleEvent(level, message, line, sourceId));
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      console.error(`[WindowManager] Renderer crashed: ${details.reason}`);
      showOnFailure();
    });
    void win.loadURL(url).catch((error: unknown) => {
      console.error(`[WindowManager] Failed to load URL ${url}:`, error);
      showOnFailure();
    });
  }

  /**
   * Create a new BrowserWindow for the given registration ID, or focus the
   * existing instance for singleton registrations.
   *
   * Tray-popover windows are positioned adjacent to the system tray icon and
   * automatically hidden when they lose focus (`dismissOnBlur`).
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

    const preloadPath = path.join(__dirname, 'preload.cjs');

    // Singleton guard: return existing window ID if one is already live
    if (registration.singleton) {
      const existing = this.findRegistrationEntry(registrationId);
      if (existing != null) {
        this.bringToFront(existing.entry.win);
        return { windowId: existing.windowId, isNew: false };
      }
    }

    const launchConfig = this.createLaunchConfig(registration, params ?? {});

    // Encode context params as a single percent-encoded JSON argument so the
    // preload script can decode them without knowing host-specific param names.
    const paramsJson = encodeRendererParams(launchConfig.params);

    const win = new BrowserWindow({
      width: registration.width,
      height: registration.height,
      title: registration.displayName,
      icon: this.iconPath,
      frame: registration.frame,
      // tray-popover windows do not appear in the dock/taskbar
      skipTaskbar: !registration.showInDock,
      // Paint the app's dark background immediately to avoid white flash
      // while the renderer loads. Matches --color-bg-primary from the Aura theme.
      backgroundColor: '#0d0f12',
      // Show the BrowserWindow immediately so the renderer splash/loading
      // state is visible even before React mounts or service boot completes.
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: preloadPath,
        additionalArguments: [
          `--makaio-bus-url=${this.busUrl}`,
          `--makaio-window-id=${launchConfig.windowId}`,
          `--makaio-package-name=${launchConfig.packageName}`,
          `--makaio-params=${paramsJson}`,
          ...(launchConfig.bootComplete ? ['--makaio-boot-complete'] : []),
        ],
      },
    });

    const windowId = win.id;

    const entry: WindowEntry = { win, registrationId, params };
    this.registry.set(windowId, entry);
    win.on('focus', () => {
      this.markWindowActive(windowId);
    });

    // Tray-popover: position near the tray icon and hide on blur
    if (registration.style === 'tray-popover') {
      this.positionTrayPopover(win);
      if (registration.dismissOnBlur) {
        win.on('blur', () => {
          if (!win.isDestroyed()) win.hide();
        });
      }
    }

    // Load the web UI
    const url = this.buildUrl(launchConfig);
    console.info(`[WindowManager] Loading URL: ${url}`);
    console.info(`[WindowManager] Preload: ${preloadPath}`);
    this.attachWindowContentObservers(win, url);

    if (this.isDev) {
      win.webContents.openDevTools();
    }

    // Clean up registry on close (no bus interaction — callers handle that)
    win.on('closed', () => {
      this.registry.delete(windowId);
    });

    return { windowId, isNew: true };
  }

  /**
   * Focus a specific window, or the most recently active window if no ID is provided.
   * @param windowId - Electron window ID to focus; omit to focus most recently active
   * @returns `true` if a window was focused, `false` if no matching window exists
   */
  public focusWindow(windowId?: number): boolean {
    if (windowId == null) return this.focusMostRecentWindow() !== null;

    const entry = this.registry.get(windowId);
    if (entry == null) return false;
    if (entry.win.isDestroyed()) {
      this.registry.delete(windowId);
      return false;
    }
    this.bringToFront(entry.win);
    this.markWindowActive(windowId);
    return true;
  }

  /**
   * Focus the most recently active managed window.
   * @returns Focused Electron window ID, or `null` when no windows are open.
   */
  public focusMostRecentWindow(): number | null {
    const entries = Array.from(this.registry.entries());
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [windowId, entry] = entries[i];
      if (entry.win.isDestroyed()) {
        this.registry.delete(windowId);
        continue;
      }
      this.bringToFront(entry.win);
      this.markWindowActive(windowId);
      return windowId;
    }
    return null;
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
   * @param windowId - The Electron window ID
   * @returns A readonly snapshot, or undefined if not found
   */
  public getWindow(windowId: number): Readonly<WindowEntry> | undefined {
    const entry = this.registry.get(windowId);
    if (!entry) return undefined;
    return { ...entry };
  }

  /**
   * Find the first open window with the given registration ID.
   *
   * O(n) over open windows; typical window counts are small (single digits).
   * @param registrationId - Qualified window registration ID to search for
   * @returns A {@link WindowState} snapshot, or `undefined` if no matching
   *   window is currently open
   */
  public findWindowByRegistrationId(registrationId: string): WindowManagerState | undefined {
    const match = this.findRegistrationEntry(registrationId);
    return match ? this.toState(match.windowId, match.entry) : undefined;
  }

  /**
   * Update the display label for a window.
   *
   * Replaces the registry entry with a new snapshot carrying the updated label.
   * @param windowId - Electron window ID
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
   * Hide all managed windows. Registry entries are preserved so windows can
   * be restored with {@link showAll}.
   */
  public hideAll(): void {
    for (const entry of this.registry.values()) {
      if (!entry.win.isDestroyed()) {
        entry.win.hide();
      }
    }
  }

  /**
   * Show all previously hidden managed windows.
   */
  public showAll(): void {
    for (const entry of this.registry.values()) {
      if (!entry.win.isDestroyed()) {
        entry.win.show();
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Find the first live registry entry for a registration ID together with its
   * Electron window ID.
   * @param registrationId - The qualified window registration ID to search for
   * @returns Matching registry entry and window ID, or `undefined`
   */
  private findRegistrationEntry(registrationId: string): { windowId: number; entry: WindowEntry } | undefined {
    for (const [windowId, entry] of this.registry.entries()) {
      if (entry.registrationId === registrationId) {
        return { windowId, entry };
      }
    }
    return undefined;
  }

  /**
   * Position a tray-popover window near the bottom-right of the primary display,
   * anchored toward the system tray area.
   *
   * Uses the primary display bounds as the anchor. On macOS the tray is in the
   * menu bar (top-right); on Windows/Linux it is in the taskbar (bottom-right).
   * Both cases are approximated by anchoring to the bottom-right of the work area
   * (which excludes the taskbar/menu bar on all platforms).
   * @param win - The BrowserWindow to position
   */
  private positionTrayPopover(win: BrowserWindow): void {
    const display = screen.getPrimaryDisplay();
    const { workArea } = display;
    const bounds = win.getBounds();
    const margin = 8;

    // Anchor to the bottom-right corner of the work area (near the tray)
    const x = workArea.x + workArea.width - bounds.width - margin;
    const y = workArea.y + workArea.height - bounds.height - margin;

    win.setPosition(Math.round(x), Math.round(y));
  }

  /**
   * Construct the web UI URL for a window registration.
   *
   * Pattern: `<baseUrl>/?app={packageName}&window={qualifiedId}[&key=value…]`
   *
   * The renderer reads `windowId` (qualified ID) and `packageName` from
   * `window.__MAKAIO_CONFIG__` injected by the preload script via
   * `additionalArguments`; query params are for DevTools readability only.
   * Keeping package names out of the HTTP path avoids Vite treating dotted
   * package names as asset requests instead of serving the SPA HTML fallback.
   * @param registration - Window registration providing packageName and windowId
   * @param params - Context parameters appended as query string entries
   * @returns Fully constructed URL string
   */
  private createLaunchConfig(
    registration: Pick<WindowRegistration, 'packageName' | 'qualifiedId'>,
    params: Readonly<Record<string, string>>,
  ): RendererLaunchConfig {
    assertNoReservedWindowParams(params, RESERVED_BOOTSTRAP_QUERY_KEYS, 'Electron');

    return createRendererLaunchConfig({
      baseUrl: this.baseUrl,
      busUrl: this.busUrl,
      registration,
      params,
      bootComplete: this.bootComplete,
    });
  }

  /**
   * Construct the web UI URL from normalized renderer launch config.
   * @param launchConfig - Renderer launch config.
   * @returns Fully constructed URL string.
   */
  private buildUrl(launchConfig: RendererLaunchConfig): string {
    return buildRendererLaunchUrl(launchConfig);
  }

  /**
   * Convert a registry entry to a {@link WindowManagerState} snapshot.
   * @param windowId - Electron window ID
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

  /**
   * Move a window to the end of the registry so iteration order reflects activity.
   * @param windowId - Electron window ID that became active.
   */
  private markWindowActive(windowId: number): void {
    const entry = this.registry.get(windowId);
    if (entry == null) return;
    this.registry.delete(windowId);
    this.registry.set(windowId, entry);
  }
}
