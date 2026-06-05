/**
 * Pure Electron tray menu template builder.
 *
 * The native tray module imports Electron at runtime; this module only imports
 * Electron types so unit tests can validate menu ordering without requiring an
 * installed Electron binary.
 */

import type { MenuItemConstructorOptions } from 'electron';
import { TrayMenuSectionSchema, type TrayMenuListEntry } from '@makaio/services-core/tray-menu';
import type { WindowState } from '@makaio/host-shared';
import type { WindowRegistration } from '@makaio/kernel';

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
