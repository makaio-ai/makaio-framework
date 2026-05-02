/**
 * Native system tray for the Electrobun host shell.
 *
 * The tray icon uses Electrobun's native `Tray` API:
 * - Any click: toggle the frameless tray popover (via {@link toggleTrayPopover}).
 *
 * Electrobun fires all tray interactions through a single `tray-clicked` event
 * carrying an optional `action` string. A bare click (no action) toggles the
 * popover. Named actions from menu items are dispatched via {@link handleTrayAction}.
 *
 * **Native context menu limitation:** Electrobun's `setMenu()` attaches a
 * native macOS context menu that intercepts ALL tray clicks (left and right),
 * which prevents the bare-click `tray-clicked` event from firing. Because
 * Electrobun offers no `popUpContextMenu()` equivalent and no left/right click
 * distinction, we deliberately do NOT call `setMenu()`. The `buildTrayMenuTemplate`
 * helper remains available for testing and future use (e.g. if Electrobun gains
 * a right-click-only API).
 *
 * Differences from the Electron tray:
 * - `tray.getBounds()` is available — exposed on {@link TrayHandle} for
 *   popover anchor computation.
 * - Global shortcut is registered separately via {@link GlobalShortcut} in
 *   the composition root (main.ts) because Electrobun's shortcut API differs
 *   from Electron's.
 * - No native context menu — all tray interactions toggle the popover.
 * @packageDocumentation
 */

import { Tray } from 'electrobun/bun';
import type { MenuItemConfig, Rectangle } from 'electrobun/bun';
import { TrayMenuSectionSchema, type TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import type { WindowManagerState } from '@makaio/host-shared';
import type { WindowRegistration } from '@makaio/kernel';
import { toggleTrayPopover, anchorFromTrayBounds } from './tray-popover.js';

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
 * @param entry - Tray entry to inspect.
 * @param key - Metadata key to read.
 * @returns String value when present.
 */
function getStringMetadata(entry: TrayMenuListEntry, key: string): string | undefined {
  const value = entry.metadata?.[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build the context menu template from current window state and loaded packages.
 *
 * Pure function — testable without Electrobun runtime. Returns
 * `MenuItemConfig[]` for use if Electrobun gains a right-click-only menu API.
 *
 * Layout:
 * 1. Framework "Dashboard" entry (always first)
 * 2. Separator (only when subsequent items exist)
 * 3. Live window items (click → focus that window)
 * 4. Separator (only when both windows and launcher entries exist)
 * 5. Launcher items grouped by section (click → item.clicked)
 * 6. Separator (only when preceding items exist)
 * 7. "Launch at Login" toggle (only when auto-launch is supported)
 * 8. Quit
 * @param windows - Current window states from WindowManager.
 * @param entries - Launcher entries from the tray menu service.
 * @param registrations - Window registrations for singleton-focus resolution.
 * @param callbacks - Optional click handlers (omitted in tests).
 * @param autoLaunchEnabled - Current auto-launch state. `null` means the
 *   feature is not supported on this platform and the item is omitted.
 * @returns Menu config array (currently used only in tests; see module-level limitation note).
 */
export function buildTrayMenuTemplate(
  windows: readonly WindowManagerState[],
  entries: readonly TrayMenuListEntry[],
  registrations: readonly WindowRegistration[],
  callbacks?: {
    focusWindow: FocusWindowFn;
    createWindow: CreateWindowByIdFn;
    onItemClicked: (entry: TrayMenuListEntry) => void;
    /** Opens the main dashboard window. Called when the Dashboard menu item is clicked. */
    openDashboard: () => void;
  },
  autoLaunchEnabled: boolean | null = null,
): MenuItemConfig[] {
  const items: MenuItemConfig[] = [];

  // Framework-owned "Dashboard" entry — always first, before live windows.
  items.push({
    type: 'normal',
    label: 'Dashboard',
    action: callbacks ? 'open-dashboard' : undefined,
    enabled: true,
  });

  // Insert a separator between Dashboard and live-window/launcher items only
  // when those items exist.
  const hasSubsequentItems = windows.length > 0 || entries.length > 0;
  if (hasSubsequentItems) {
    items.push({ type: 'separator' });
  }

  // Live window items
  for (const win of windows) {
    items.push({
      type: 'normal',
      label: win.label ?? win.registrationId,
      action: callbacks ? `focus-window-${win.windowId}` : undefined,
      enabled: true,
    });
  }

  // Separator between live windows and launchers (only when both exist)
  if (windows.length > 0 && entries.length > 0) {
    items.push({ type: 'separator' });
  }

  if (entries.length > 0) {
    // Entries arrive pre-sorted by section → priority → label from the
    // TrayMenuService. TrayMenuSectionSchema.options defines the canonical
    // section sequence shared across all tray renderers.
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
        items.push({
          type: 'normal',
          label: entry.label,
          enabled: entry.enabled,
          action: callbacks ? `item-clicked-${entry.entryId}` : undefined,
        });
      }
    }
  }

  // "Launch at Login" toggle — only shown when the platform package reports
  // that auto-launch is supported (autoLaunchEnabled !== null).
  if (autoLaunchEnabled !== null) {
    if (items.length > 0) {
      items.push({ type: 'separator' });
    }
    items.push({
      type: 'normal',
      label: 'Launch at Login',
      action: callbacks ? 'toggle-auto-launch' : undefined,
      checked: autoLaunchEnabled,
      enabled: true,
    });
  }

  // Final separator + quit (only insert separator when preceding items exist)
  if (items.length > 0) {
    items.push({ type: 'separator' });
  }
  items.push({ type: 'normal', label: 'Quit', action: 'quit' });

  return items;
}

/**
 * Dispatch a tray action string to the appropriate `deps` callback.
 *
 * Pure function — encapsulates all action routing so that `createTray` and
 * tests share the same dispatch logic. Handles:
 * - `quit` → `deps.onQuit()`
 * - `open-dashboard` → `deps.openDashboard()`
 * - `toggle-auto-launch` → `deps.toggleAutoLaunch()`
 * - `focus-window-<id>` → `deps.focusWindow(id)`
 * - `item-clicked-<entryId>` → `deps.onItemClicked(entry)`, then
 *   focus the existing singleton window or create a new one when the entry
 *   carries a `registrationId` metadata key.
 * @param action - Action string from the menu item.
 * @param deps - Injected dependencies providing callbacks and state accessors.
 */
export function handleTrayAction(action: string, deps: TrayDeps): void {
  if (action === 'quit') {
    deps.onQuit();
    return;
  }

  if (action === 'open-dashboard') {
    deps.openDashboard();
    return;
  }

  if (action === 'toggle-auto-launch') {
    deps.toggleAutoLaunch();
    return;
  }

  const focusMatch = /^focus-window-(\d+)$/.exec(action);
  if (focusMatch) {
    deps.focusWindow(Number(focusMatch[1]));
    return;
  }

  const itemMatch = /^item-clicked-(.+)$/.exec(action);
  if (itemMatch) {
    const entryId = itemMatch[1];
    const entry = deps.getEntries().find((e) => e.entryId === entryId);
    if (!entry) return;

    deps.onItemClicked(entry);

    const registrationId = getStringMetadata(entry, 'registrationId');
    if (!registrationId) return;

    const registrations = deps.listRegistrations();
    const reg = registrations.find((r) => r.qualifiedId === registrationId);
    if (!reg) return;

    const existing = reg.singleton ? deps.listWindows().find((w) => w.registrationId === registrationId) : undefined;

    if (existing) {
      deps.focusWindow(existing.windowId);
    } else {
      deps.createWindow(reg.qualifiedId);
    }
  }
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
  listWindows: () => WindowManagerState[];
  /** Returns the current list of window registrations from the registry. */
  listRegistrations: () => readonly WindowRegistration[];
  /** Returns tray entries from the tray menu service snapshot. */
  getEntries: () => readonly TrayMenuListEntry[];
  /** Focus an existing window by window ID. */
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
   * through the bus so the registered handler handles singleton-focus semantics.
   */
  openDashboard: () => void;
  /** Quit the application (composition root lifecycle hook). */
  onQuit: () => void;
  /**
   * Current auto-launch enabled state.
   *
   * `null` means the platform package is not loaded or does not support
   * auto-launch — the "Launch at Login" menu item is omitted entirely.
   * `true`/`false` reflects the current OS login-item registration state.
   */
  autoLaunchEnabled: boolean | null;
  /**
   * Toggle auto-launch on or off.
   *
   * Called when the user clicks the "Launch at Login" menu item. The
   * implementation in `main.ts` dispatches the appropriate
   * `PlatformSubjects.autoLaunch.enable` or `.disable` request and updates
   * `autoLaunchEnabled` state before refreshing the menu.
   */
  toggleAutoLaunch: () => void;
}

/** Lifecycle handles returned by {@link createTray}. */
export interface TrayHandle {
  /** Destroy the native tray. */
  destroy: () => void;
  /** Return the current screen bounds of the tray icon. */
  getTrayBounds: () => Rectangle;
  /**
   * No-op on Electrobun.
   *
   * On Electrobun, attaching a native menu via `setMenu()` causes macOS to
   * intercept all tray clicks (left and right) for the native context menu,
   * preventing the `tray-clicked` bare-click path from being reached. To
   * preserve left-click → popover toggle behavior, no menu is ever attached.
   * Callers may invoke this for parity with the Electron host without effect.
   */
  refreshMenu: () => void;
}

/**
 * Create and wire the system tray icon.
 *
 * Returns lifecycle handles for the native tray. All tray clicks fire the
 * `tray-clicked` event with no action, which toggles the popover. Named action
 * dispatch via {@link handleTrayAction} is retained for completeness but is
 * not reachable without a native menu attached.
 *
 * Differences from the Electron tray:
 * - No native context menu — `setMenu()` is never called because it would
 *   intercept all tray clicks and prevent popover toggling.
 * - Global shortcut is registered by the composition root (main.ts) using
 *   `GlobalShortcut` directly, not inside this function.
 * @param deps - Injected dependencies for window management and package data.
 * @returns Tray lifecycle handles.
 */
export function createTray(deps: TrayDeps): TrayHandle {
  const tray = new Tray({
    image: deps.iconPath,
    template: true,
    width: 22,
    height: 22,
  });

  // All tray clicks arrive here. Without a native menu attached (see module
  // JSDoc), every click is a bare click with no action → popover toggle.
  tray.on('tray-clicked', (event: unknown) => {
    const e = event as { data?: { action?: string } };
    const action = e?.data?.action;
    if (!action) {
      // Bare icon click (no menu action) — toggle the tray popover anchored
      // to the tray icon.
      const bounds = tray.getBounds();
      toggleTrayPopover({ anchor: anchorFromTrayBounds(bounds) });
      return;
    }
    handleTrayAction(action, deps);
  });

  // No-op — see TrayHandle.refreshMenu JSDoc.
  const refreshMenu = (): void => {};

  const getTrayBounds = (): Rectangle => tray.getBounds();

  const destroy = (): void => {
    tray.remove();
  };

  return { destroy, getTrayBounds, refreshMenu };
}
