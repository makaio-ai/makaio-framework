/**
 * React hook wrapper for the pure tray layout derivation.
 *
 * Keeps React runtime and subscription ownership in `@makaio/ui-hooks` while
 * the ordering algorithm itself stays in `@makaio/ui-kernel`.
 * @packageDocumentation
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { deriveTrayLayout, widgetRegistry, type WidgetLayout } from '@makaio/ui-kernel';

/** Stable empty array used as the default for `lockedWidgetIds`. */
const EMPTY_LOCKED_IDS: readonly string[] = Object.freeze([]);

/**
 * Derive a read-only `WidgetLayout` for the tray surface from the live widget registry.
 * @param lockedWidgetIds - Widget IDs that should be pinned at the top of the tray.
 * @returns Stable tray layout derived from the current widget registry snapshot.
 */
export function useTrayLayout(lockedWidgetIds: readonly string[] = EMPTY_LOCKED_IDS): WidgetLayout {
  const subscribe = useCallback((callback: () => void) => widgetRegistry.subscribe(callback), []);
  const getSnapshot = useCallback(() => widgetRegistry.getAll(), []);
  const allWidgets = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(() => deriveTrayLayout(allWidgets, lockedWidgetIds), [allWidgets, lockedWidgetIds]);
}
