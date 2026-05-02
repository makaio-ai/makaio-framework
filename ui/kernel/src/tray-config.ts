/**
 * Shared tray popover sizing constants.
 *
 * Centralises every pixel and grid value that must agree between the Electron
 * main-process window creation (`tray-popover.ts`) and the React canvas layout
 * (`tray-view.tsx`). A single edit here propagates to both surfaces.
 * @packageDocumentation
 */

/** Tray popover window width in CSS/screen pixels. */
export const TRAY_WINDOW_WIDTH_PX = 480;

/** Tray popover window height in CSS/screen pixels. */
export const TRAY_WINDOW_HEIGHT_PX = 500;

/**
 * Horizontal padding on each side applied by the canvas container when in
 * fixed mode (`.fixed .gridArea { padding: 8px }`). Subtracted from the
 * window width on both sides to derive the usable grid width.
 */
export const TRAY_CANVAS_HORIZONTAL_PADDING_PX = 8;

/** Number of grid columns in the tray canvas (non-responsive, fixed). */
export const TRAY_GRID_COLS = 2;

/** Row height in pixels for the tray widget grid. */
export const TRAY_ROW_HEIGHT_PX = 60;

/** Cell margin tuple `[horizontal, vertical]` in pixels used by the tray `react-grid-layout` instance. */
export const TRAY_CELL_MARGIN: [number, number] = [8, 8];

/**
 * Effective grid width passed to the non-responsive `GridLayout`.
 *
 * Derived as: `TRAY_WINDOW_WIDTH_PX - 2 * TRAY_CANVAS_HORIZONTAL_PADDING_PX`
 * = 480 - 16 = 464 px.
 */
export const TRAY_GRID_WIDTH_PX = TRAY_WINDOW_WIDTH_PX - TRAY_CANVAS_HORIZONTAL_PADDING_PX * 2;
