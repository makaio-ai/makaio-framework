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
import type { MenuItemConstructorOptions } from 'electron';
import { TrayMenuSectionSchema, type TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import type { WindowState } from '@makaio/host-shared';
import type { WindowRegistration } from '@makaio/kernel';
import { toggleTrayPopover } from './tray-popover.js';

/** Global shortcut accelerator for toggling the popover. */
const GLOBAL_SHORTCUT = 'Alt+CommandOrControl+M';

/**
 * Window focus callback type for the tray.
 * @param windowId - ID of the window to focus.
 */
export type FocusWindowFn = (windowId: number) => void;

/**
 * Window creation callback type for the tray.
 * @param registrationId - Qualified window registration ID to create.
 */
export type CreateWindowByIdFn = (registrationId: string) => void;

/**
 * Read a string metadata value from a tray entry.
 * @param entry - Tray entry to inspect
 * @param key - Metadata key to read
 * @returns String value when present
 */
function getStringMetadata(entry: TrayMenuListEntry, key: string): string | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build the context menu template from current window state and loaded packages.
 *
 * Pure function — testable without Electron runtime. Returns
 * `MenuItemConstructorOptions[]` suitable for `Menu.buildFromTemplate()`.
 *
 * Layout:
 * 1. Framework "Dashboard" entry (always first)
 * 2. Separator (only when subsequent items exist after Dashboard)
 * 3. Live window items (click → focus that window)
 * 4. Separator (only when both windows and launcher entries exist)
 * 5. Launcher items grouped by section (click → item.clicked, plus optional window shortcut)
 * 6. Separator (only when preceding items exist)
 * 7. Quit
 * @param windows - Current window states from WindowManager.
 * @param entries - Launcher entries from the tray menu service.
 * @param registrations - Window registrations for singleton-focus resolution.
 * @param callbacks - Optional click handlers (omitted in tests).
 * @returns Menu template array.
 */
export function buildTrayMenuTemplate(
  windows: readonly WindowState[],
  entries: readonly TrayMenuListEntry[],
  registrations: readonly WindowRegistration[],
  callbacks?: {
    focusWindow: FocusWindowFn;
    createWindow: CreateWindowByIdFn;
    onItemClicked: (entry: TrayMenuListEntry) => void;
    /** Opens the main dashboard window. Called when the Dashboard menu item is clicked. */
    openDashboard: () => void;
  },
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];

  // Framework-owned "Dashboard" entry — always first, before live windows.
  // `callbacks` is optional so tests can build the template without wiring;
  // fields inside `callbacks` are non-optional by type, so `?.` guards only
  // the enclosing object, not the property.
  items.push({
    label: 'Dashboard',
    type: 'normal',
    click: callbacks?.openDashboard,
  });

  // Insert a separator between Dashboard and live-window/launcher items only
  // when those items exist. The trailing separator before Quit is always
  // added below.
  const hasSubsequentItems = windows.length > 0 || entries.length > 0;
  if (hasSubsequentItems) {
    items.push({ type: 'separator' });
  }

  // Live window items
  for (const win of windows) {
    items.push({
      label: win.label ?? win.registrationId,
      type: 'normal',
      click: callbacks ? () => callbacks.focusWindow(win.windowId) : undefined,
    });
  }

  // Separator between live windows and launchers (only when both exist)
  if (windows.length > 0 && entries.length > 0) {
    items.push({ type: 'separator' });
  }

  if (entries.length > 0) {
    // Entries arrive pre-sorted by section → priority → label from the
    // TrayMenuService. The renderer groups by section without re-sorting.
    // Display order is a renderer concern; TrayMenuSectionSchema.options defines
    // the canonical section sequence shared across all tray renderers.
    const sections = TrayMenuSectionSchema.options;
    let firstSection = true;

    for (const section of sections) {
      const group = entries.filter((e) => e.section === section);
      if (group.length === 0) continue;

      if (!firstSection) {
        items.push({ type: 'separator' });
      }
      firstSection = false;

      for (const entry of group) {
        const registrationId = getStringMetadata(entry, 'registrationId');
        const reg = registrationId ? registrations.find((r) => r.qualifiedId === registrationId) : undefined;
        const existing = reg?.singleton ? windows.find((w) => w.registrationId === registrationId) : undefined;

        items.push({
          label: entry.label,
          type: 'normal',
          enabled: entry.enabled,
          click: callbacks
            ? () => {
                callbacks.onItemClicked(entry);
                // Only attempt window operations when the registrationId
                // matches a known window registration. Unknown IDs are
                // silently ignored — the extension still receives the
                // item.clicked event and can handle it via the bus.
                if (!reg) return;
                if (existing) {
                  callbacks.focusWindow(existing.windowId);
                } else {
                  callbacks.createWindow(reg.qualifiedId);
                }
              }
            : undefined,
        });
      }
    }
  }

  // Final separator + quit (only insert separator when preceding items exist)
  if (items.length > 0) {
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Quit', role: 'quit' });

  return items;
}

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
