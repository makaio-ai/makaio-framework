/**
 * Focus Context Widget Layout Types
 *
 * Defines the data structures for per-window widget layouts within Focus Contexts.
 * These types describe how widgets are positioned and sized within a focus context.
 *
 * Key distinction from WidgetLayout (from \@makaio/ui-kernel):
 * - The kernel WidgetLayout uses "placements" for the dashboard/project system
 * - FocusContextLayout uses "widgets" for Focus Context-specific layouts
 * @packageDocumentation
 */

/**
 * Widget size enumeration
 */
export type FocusContextWidgetSize = 'small' | 'medium' | 'large' | 'full-width';

/**
 * A placed widget within a Focus Context layout
 *
 * Represents a widget instance with its position and size configuration.
 * The widgetId references a WidgetDeclaration from extensions.
 */
export interface PlacedFocusWidget {
  /** Widget definition ID (from plugin's WidgetDeclaration.id) */
  widgetId: string;
  /** Current size of the widget */
  size: FocusContextWidgetSize;
  /** X coordinate for free-form layouts (optional) */
  x?: number;
  /** Y coordinate for free-form layouts (optional) */
  y?: number;
  /** Width in grid units (optional) */
  width?: number;
  /** Height in grid units (optional) */
  height?: number;
}

/**
 * Widget layout for a Focus Context
 *
 * Defines how widgets are arranged within a specific focus context.
 * The version field enables future migrations.
 *
 * Note: Named FocusContextLayout to avoid conflict with WidgetLayout from \@makaio/ui-kernel.
 */
export interface FocusContextLayout {
  /** Layout version for migration support */
  version: 1;
  /** Array of placed widgets in this layout */
  widgets: PlacedFocusWidget[];
}

/**
 * Helper to create an empty widget layout
 * @returns A new empty layout with no widgets
 */
export function createEmptyFocusContextLayout(): FocusContextLayout {
  return {
    version: 1,
    widgets: [],
  };
}

/**
 * Helper to add a widget to a layout.
 *
 * Duplicate adds (same `widgetId`) are no-ops — the unchanged layout is
 * returned. This prevents non-deterministic state when callers inadvertently
 * re-add a widget that is already present.
 * @param layout - The layout to modify
 * @param widget - The placed widget to add
 * @returns A new layout with the widget added, or the original layout when
 *   a widget with the same `widgetId` already exists.
 */
export function addWidgetToFocusLayout(layout: FocusContextLayout, widget: PlacedFocusWidget): FocusContextLayout {
  if (layout.widgets.some((w) => w.widgetId === widget.widgetId)) {
    return layout;
  }
  return {
    ...layout,
    widgets: [...layout.widgets, widget],
  };
}

/**
 * Helper to remove a widget from a layout by widget ID
 * @param layout - The layout to modify
 * @param widgetId - The widget ID to remove
 * @returns A new layout with the widget removed, or the original layout when
 *   the widget is not present (referential equality on no-op).
 */
export function removeWidgetFromFocusLayout(layout: FocusContextLayout, widgetId: string): FocusContextLayout {
  if (!layout.widgets.some((w) => w.widgetId === widgetId)) {
    return layout;
  }
  return {
    ...layout,
    widgets: layout.widgets.filter((w) => w.widgetId !== widgetId),
  };
}

/**
 * Helper to update a widget's size in a layout
 * @param layout - The layout to modify
 * @param widgetId - The widget ID to update
 * @param size - The new size
 * @returns A new layout with the widget updated, or original if widget not found
 */
export function updateFocusContextWidgetSize(
  layout: FocusContextLayout,
  widgetId: string,
  size: FocusContextWidgetSize,
): FocusContextLayout {
  if (!layout.widgets.some((w) => w.widgetId === widgetId)) {
    return layout;
  }
  return {
    ...layout,
    widgets: layout.widgets.map((w) => (w.widgetId === widgetId ? { ...w, size } : w)),
  };
}

/**
 * Helper to update a widget's position in a layout
 * @param layout - The layout to modify
 * @param widgetId - The widget ID to update
 * @param position - The new position (x, y, width, height)
 * @returns A new layout with the widget updated, or original if widget not found
 */
export function updateFocusContextWidgetPosition(
  layout: FocusContextLayout,
  widgetId: string,
  position: Pick<PlacedFocusWidget, 'x' | 'y' | 'width' | 'height'>,
): FocusContextLayout {
  if (!layout.widgets.some((w) => w.widgetId === widgetId)) {
    return layout;
  }
  return {
    ...layout,
    widgets: layout.widgets.map((w) => (w.widgetId === widgetId ? { ...w, ...position } : w)),
  };
}
