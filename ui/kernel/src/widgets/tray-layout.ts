/**
 * Pure tray layout derivation helpers.
 *
 * Produces a `WidgetLayout` from a stable widget snapshot without depending on
 * React runtime APIs. React subscriptions live in `@makaio/ui-hooks`.
 * @packageDocumentation
 */

import { TRAY_GRID_COLS } from '../tray-config.js';
import { widgetMatchesScope } from './scope-registry.js';
import type { WidgetDefinition, WidgetLayout, WidgetPlacement, WidgetSize } from './types.js';

/**
 * Tray-specific size-to-row-height mapping.
 *
 * Differs from the dashboard `SIZE_MAPPING` intentionally: the tray uses a
 * single-row cell for `'small'` so that widgets with `trayDefaultSize: 'small'`
 * receive `h = 1` and `deriveWidgetSize(1)` returns `'small'`, enabling compact
 * tray rendering. Dashboard `SIZE_MAPPING.small.h` remains 2 so no existing
 * dashboard widget is affected.
 */
const TRAY_SIZE_MAPPING: Record<WidgetSize, number> = {
  small: 1,
  medium: 2,
  large: 3,
  'full-width': 4,
};

/** Stable empty array used as the default for `lockedWidgetIds`. */
const EMPTY_LOCKED_IDS: readonly string[] = Object.freeze([]);

/**
 * Derive a read-only `WidgetLayout` for the tray surface.
 *
 * Ordering contract:
 * 1. Placements whose `widgetId` appears in `lockedWidgetIds` come first, in
 *    the order they appear in `lockedWidgetIds`. These receive `locked: true`.
 * 2. All other tray-scoped widgets follow in their registration order.
 *
 * All placements default to `w: TRAY_GRID_COLS` (full tray width). The row
 * height `h` is derived from the widget's `trayDefaultSize` (if set) or
 * `defaultSize`.
 * @param allWidgets - Stable widget registry snapshot in registration order.
 * @param lockedWidgetIds - Widget IDs pinned at the top of the tray.
 * @returns Derived tray layout with deterministic placement order.
 */
export function deriveTrayLayout(
  allWidgets: readonly WidgetDefinition[],
  lockedWidgetIds: readonly string[] = EMPTY_LOCKED_IDS,
): WidgetLayout {
  const trayWidgets = allWidgets.filter((widget) => widgetMatchesScope(widget.scope, 'tray', false));
  const lockedIdSet = new Set(lockedWidgetIds);
  const trayWidgetById = new Map(trayWidgets.map((widget) => [widget.id, widget]));

  let row = 1;
  const placements: WidgetPlacement[] = [];

  const seenLockedIds = new Set<string>();
  for (const widgetId of lockedWidgetIds) {
    if (seenLockedIds.has(widgetId)) {
      continue;
    }
    seenLockedIds.add(widgetId);

    const definition = trayWidgetById.get(widgetId);
    if (!definition) {
      continue;
    }

    const traySize = definition.trayDefaultSize ?? definition.defaultSize;
    const h = TRAY_SIZE_MAPPING[traySize];

    placements.push({
      col: 1,
      h,
      instanceId: `tray:locked:${widgetId}`,
      locked: true,
      row,
      size: traySize,
      w: TRAY_GRID_COLS,
      widgetId,
    });
    row += h;
  }

  for (const definition of trayWidgets) {
    if (lockedIdSet.has(definition.id)) {
      continue;
    }

    const traySize = definition.trayDefaultSize ?? definition.defaultSize;
    const h = TRAY_SIZE_MAPPING[traySize];

    placements.push({
      col: 1,
      h,
      instanceId: `tray:item:${definition.id}`,
      row,
      size: traySize,
      w: TRAY_GRID_COLS,
      widgetId: definition.id,
    });
    row += h;
  }

  return { placements, version: 1 };
}
