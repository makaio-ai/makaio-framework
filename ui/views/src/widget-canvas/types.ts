import type { RefObject } from 'react';
import type { UiContextSnapshot } from '@makaio/contracts';
import type { WidgetDefinition, WidgetLayout } from '@makaio/ui-kernel';

/**
 * Props for the {@link WidgetCanvas} component.
 */
export interface WidgetCanvasProps {
  /** Height of a single grid row in pixels. */
  rowHeight?: number;
  /** Widget definitions available for placement on this canvas. */
  widgets: ReadonlyArray<WidgetDefinition>;
  /** Persisted layout loaded from preferences; `null` while loading. */
  savedLayout?: WidgetLayout | null;
  /** Whether the canvas is in a loading state. */
  isLoading?: boolean;
  /** Error from loading the layout, if any. */
  error?: Error | null;
  /**
   * Persist the current layout.
   * @param layout - Layout to persist.
   */
  onSaveLayout: (layout: WidgetLayout) => Promise<void>;
  /**
   * Called on every layout change (including unsaved in-progress edits).
   * @param layout - Updated layout.
   */
  onLayoutChange?: (layout: WidgetLayout) => void;
  /** Per-widget context values merged into each widget's config. */
  widgetContext?: Record<string, Record<string, unknown>>;
  /** Active host UI context for widgets rendered on this canvas. */
  uiContext?: UiContextSnapshot;
  /** Whether edit mode is externally controlled. */
  isEditing?: boolean;
  /** Toggle edit mode from the parent when `isEditing` is controlled. */
  onToggleEdit?: () => void;
  /**
   * Optional fixed-grid configuration for non-responsive canvases (e.g. the
   * tray surface). When `responsive: false` the canvas renders in a fixed
   * pixel-width mode and delegates column layout to the host.
   */
  gridConfig?: import('./WidgetGrid.js').WidgetGridConfig;
}

/**
 * Internal editing state snapshot for the widget canvas.
 */
export interface WidgetCanvasState {
  /** Whether the canvas is in edit mode. */
  isEditing: boolean;
  /** In-flight layout awaiting persistence, if any. */
  pendingLayout: WidgetLayout | null;
  /** Widget ID currently being dragged from the palette, if any. */
  draggingWidget: string | null;
}

/**
 * Props for the floating {@link WidgetPalette} panel.
 */
export interface WidgetPaletteProps {
  /** Widget definitions shown in the palette. */
  widgets: ReadonlyArray<WidgetDefinition>;
  /** Current canvas layout (used to check which widgets are already placed). */
  currentLayout: WidgetLayout;
  /**
   * Called when the user begins dragging a widget from the palette.
   * @param widgetId - ID of the widget being dragged.
   */
  onDragStart: (widgetId: string) => void;
  /** Called when a palette drag operation ends. */
  onDragEnd: () => void;
  /** Called when the user saves and exits edit mode via the palette close button. */
  onClose: () => void;
  /** Ref to the canvas container; used to clamp the floating palette position. */
  containerRef?: RefObject<HTMLDivElement | null>;
}
