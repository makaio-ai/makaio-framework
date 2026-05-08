/** \@makaio/ui-views - composed React views, shell, smart components. */

// ---------------------------------------------------------------------------
// Widget infrastructure
// ---------------------------------------------------------------------------
export { WidgetContainer, type WidgetContainerProps } from './widgets/WidgetContainer.js';

export { frameworkStatusWidgetDefinition } from './widgets/built-in/StatusWidget.js';

// ---------------------------------------------------------------------------
// Widget canvas
// ---------------------------------------------------------------------------
export { WidgetCanvas } from './widget-canvas/WidgetCanvas.js';
export type { WidgetCanvasProps, WidgetCanvasState, WidgetPaletteProps } from './widget-canvas/types.js';

export { WidgetGrid, SIZE_MAPPING, deriveWidgetSize } from './widget-canvas/WidgetGrid.js';
export { WidgetPalette } from './widget-canvas/WidgetPalette.js';
export { WidgetErrorBoundary } from './widget-canvas/WidgetErrorBoundary.js';
export {
  WIDGET_DRAG_DATA_TYPE,
  getWidgetDragData,
  setWidgetDragData,
  type WidgetDragPayload,
  type DataTransferLike,
} from './widget-canvas/drag-payload.js';

// ---------------------------------------------------------------------------
// Shell components
// ---------------------------------------------------------------------------
export { FrameworkShell } from './shell/FrameworkShell.js';
export { BusStatusIndicator } from './shell/BusStatusIndicator.js';
export { SheetOverlay } from './shell/SheetOverlay.js';
export { TrayView } from './shell/tray-view.js';

// ---------------------------------------------------------------------------
// Extension loading
// ---------------------------------------------------------------------------
export { ExtensionBrowserLoader } from './extensions/ExtensionBrowserLoader.js';
export { EmptyStateUI, type EmptyStateUIProps } from './extensions/EmptyStateUI.js';

// ---------------------------------------------------------------------------
// Page rendering
// ---------------------------------------------------------------------------
export { PageErrorBoundary } from './page/PageErrorBoundary.js';

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
export { Sidebar } from './nav/Sidebar.js';

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
export { ToastProvider, type ToastProviderProps } from './toast/index.js';
