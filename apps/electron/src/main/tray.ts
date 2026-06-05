/**
 * Native system tray for the Electron host shell.
 *
 * The tray icon uses Electron's native `Tray` + `Menu` APIs:
 * - macOS / Windows left click: toggle the frameless tray popover.
 * - Linux tray activation: refresh the persistent context menu.
 * - Context menu: live window list + bus-registered launcher items + quit.
 * - Global shortcut `Alt+Cmd+M`: toggle the popover (centered on screen when no anchor).
 *
 * Menu items are derived from current windows and `host:tray.list`. A
 * framework-owned "Dashboard" entry is always present as the first item.
 * When there are no open windows and no packages declare tray entries, the
 * menu contains Dashboard, a separator, and Quit.
 * @packageDocumentation
 */

import { app, globalShortcut, Menu, nativeImage, Tray } from 'electron';
import type { TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import type { WindowState } from '@makaio/host-shared';
import type { WindowRegistration } from '@makaio/kernel';
import { toggleTrayPopover } from './tray-popover.js';
import { buildTrayMenuTemplate, type CreateWindowByIdFn, type FocusWindowFn } from './tray-menu-template.js';
export { buildTrayMenuTemplate, type CreateWindowByIdFn, type FocusWindowFn } from './tray-menu-template.js';

/** Global shortcut accelerator for toggling the popover. */
const GLOBAL_SHORTCUT = 'Alt+CommandOrControl+M';

/**
 * Dependencies injected into `createTray`.
 *
 * Separates the tray module from both {@link WindowManager} and the package
 * registry to keep each concern independently testable.
 */
export interface TrayDeps {
  /** Path to the tray icon image. */
  iconPath: string;
  /** Returns the current list of open windows. */
  listWindows: () => WindowState[];
  /** Returns the current list of window registrations from the registry. */
  listRegistrations: () => readonly WindowRegistration[];
  /** Returns tray entries from the tray menu service snapshot. */
  getEntries: () => readonly TrayMenuListEntry[];
  /** Focus an existing window by Electron window ID. */
  focusWindow: FocusWindowFn;
  /** Create a new window by qualified registration ID. */
  createWindow: CreateWindowByIdFn;
  /** Emit a typed tray item click event. */
  onItemClicked: (entry: TrayMenuListEntry) => void;
  /**
   * Opens the main dashboard window (focus or create).
   *
   * Called when the user clicks the "Dashboard" context menu entry. The
   * implementation in `main.ts` dispatches `HostSubjects.window.openDashboard`
   * through the bus so the registered Phase-3 handler handles singleton-focus
   * semantics.
   */
  openDashboard: () => void;
}

/** Lifecycle handles returned by {@link createTray}. */
export interface TrayHandle {
  /** Destroy the native tray and unregister global shortcuts. */
  destroy: () => void;
  /** Return the current screen bounds of the tray icon on supported platforms. */
  getTrayBounds: () => Electron.Rectangle;
  /** Refresh the persistent Linux tray menu from current runtime state. */
  refreshMenu: () => void;
}

/**
 * Create and wire the system tray icon.
 *
 * Returns lifecycle handles for the native tray. macOS/Windows use split
 * click handlers for popover vs context menu. Linux uses a persistent
 * context menu because Electron only documents `right-click`,
 * `popUpContextMenu()`, and `getBounds()` on macOS/Windows.
 * @param deps - Injected dependencies for window management and package data.
 * @returns Tray lifecycle handles.
 */
export function createTray(deps: TrayDeps): TrayHandle {
  const appName = app.getName().trim() || 'Framework';
  const trayIcon = nativeImage.createFromPath(deps.iconPath).resize({ width: 22, height: 22 });
  const tray = new Tray(trayIcon);
  tray.setToolTip(appName);

  const buildContextMenu = (): Electron.Menu =>
    Menu.buildFromTemplate(
      buildTrayMenuTemplate(deps.listWindows(), deps.getEntries(), deps.listRegistrations(), {
        focusWindow: deps.focusWindow,
        createWindow: deps.createWindow,
        onItemClicked: deps.onItemClicked,
        openDashboard: deps.openDashboard,
      }),
    );

  const refreshMenu = (): void => {
    if (process.platform === 'linux') {
      tray.setContextMenu(buildContextMenu());
    }
  };

  if (process.platform === 'linux') {
    // Electron only documents getBounds/right-click/popUpContextMenu on macOS
    // and Windows. Linux relies on a persistent context menu; the global
    // shortcut remains the reliable popover affordance there.
    refreshMenu();
    tray.on('click', () => {
      refreshMenu();
    });
  } else {
    // Left-click: toggle the frameless tray popover anchored to the tray icon.
    tray.on('click', (_event, bounds) => {
      const anchor = {
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height),
      };
      toggleTrayPopover({ anchor });
    });

    // Right-click: build and show the context menu on demand with fresh data.
    // Building here (rather than caching via setContextMenu) ensures the
    // window list and tray entries are up-to-date at the moment of display.
    tray.on('right-click', () => {
      tray.popUpContextMenu(buildContextMenu());
    });
  }

  // Global shortcut: toggle the popover (centered on screen when no anchor).
  const registered = globalShortcut.register(GLOBAL_SHORTCUT, () => {
    toggleTrayPopover();
  });

  if (!registered) {
    console.warn(`[Tray] Failed to register global shortcut ${GLOBAL_SHORTCUT}`);
  }

  const handleBeforeQuit = (): void => {
    globalShortcut.unregister(GLOBAL_SHORTCUT);
  };
  app.on('before-quit', handleBeforeQuit);

  const destroy = (): void => {
    app.off('before-quit', handleBeforeQuit);
    globalShortcut.unregister(GLOBAL_SHORTCUT);
    tray.destroy();
  };

  const getTrayBounds = (): Electron.Rectangle => tray.getBounds();

  return { destroy, getTrayBounds, refreshMenu };
}
