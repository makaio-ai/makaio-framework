/* eslint max-lines-per-function: ["error", { max: 500 }] */
import { useMemo, useRef, type FC, type JSX, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import GridLayout, { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import styles from './WidgetGrid.module.scss';
import { WidgetErrorBoundary } from './WidgetErrorBoundary.js';
import { HostSubjects } from '@makaio/contracts';
import type { UiContextSnapshot } from '@makaio/contracts';
import {
  DEFAULT_WIDGET_UI_CONTEXT,
  WidgetSubjects,
  type WidgetDefinition,
  type WidgetLayout,
  type WidgetPlacement,
  type WidgetSize,
} from '@makaio/ui-kernel';
import { useOptionalBus, usePageOverlayStore } from '@makaio/ui-hooks';

const ResponsiveGridLayoutWithWidth = WidthProvider(Responsive);

/**
 * Configuration for the widget grid layout engine.
 *
 * A discriminated union on `responsive` ensures that the non-responsive branch
 * always receives the mandatory `cols` and `width` values it requires, making
 * silent misconfiguration a compile-time error.
 * @example Responsive mode (default — omit `gridConfig` or pass this shape):
 * ```tsx
 * <WidgetCanvas gridConfig={{ responsive: true }} … />
 * ```
 * @example Fixed-column mode for constrained surfaces such as the tray popover:
 * ```tsx
 * <WidgetCanvas gridConfig={{ responsive: false, cols: 2, width: 480 }} … />
 * ```
 */
export type WidgetGridConfig =
  | {
      /**
       * Enables react-grid-layout's `Responsive` component with automatic
       * breakpoint detection. This is the default mode.
       */
      responsive: true;
    }
  | {
      /**
       * Disables breakpoint-responsive behaviour. A plain `GridLayout` is
       * rendered with a fixed column count and an explicit pixel width.
       * Use for constrained surfaces (e.g. tray popovers) where column
       * changes on resize are undesirable.
       */
      responsive: false;
      /** Number of columns in the fixed grid. */
      cols: number;
      /** Total grid width in pixels. Required to prevent silent misconfiguration. */
      width: number;
      /** Row height in px. Falls back to the `WidgetGrid` `rowHeight` prop. */
      rowHeight?: number;
      /** [horizontal, vertical] gap in px. Defaults to `[8, 8]`. */
      margin?: [number, number];
    };

interface WidgetGridProps {
  /** Persisted widget layout. */
  layout: WidgetLayout;
  /** Widget definitions for rendering grid items. */
  widgets: ReadonlyArray<WidgetDefinition>;
  /** Whether the grid is in edit mode (draggable/removable). */
  isEditing: boolean;
  /**
   * Called when the user changes the grid layout.
   * @param layout - Updated widget layout.
   */
  onLayoutChange: (layout: WidgetLayout) => void;
  /**
   * Called when the user removes a widget from the grid.
   * @param instanceId - Instance ID of the widget to remove.
   */
  onRemoveWidget: (instanceId: string) => void;
  /** Height of a single grid row in pixels. */
  rowHeight?: number;
  /** Per-widget context values merged into each widget's config. */
  widgetContext?: Record<string, Record<string, unknown>>;
  /** Active host UI context for widgets rendered in this grid. */
  uiContext?: UiContextSnapshot;
  /** RGL dropping placeholder item. */
  droppingItem?: { i: string; w: number; h: number };
  /**
   * Called when a widget is dropped onto the grid from the palette.
   * @param layout - Current RGL layout array.
   * @param item - Drop target position.
   * @param event - Native drag event carrying widget drag data.
   */
  onDrop?: (layout: Layout[], item: Layout, event: DragEvent) => void;
  /** Optional layout engine configuration. When absent, defaults to responsive mode. */
  gridConfig?: WidgetGridConfig;
}

/** Maps semantic widget sizes to their default grid dimensions. */
export const SIZE_MAPPING: Record<WidgetSize, { w: number; h: number }> = {
  'full-width': { h: 4, w: 12 },
  large: { h: 3, w: 6 },
  medium: { h: 2, w: 4 },
  small: { h: 2, w: 3 },
};

const BREAKPOINT_COLS: Record<string, number> = { lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 };

/**
 * Derive a semantic widget size from actual grid dimensions.
 *
 * Height is the primary signal because vertical space determines whether
 * a widget can show detailed content (extension list) or must show a
 * compact summary. Width is handled naturally by CSS within each tier.
 * @param h - Current grid height in rows.
 * @returns Semantic size for the widget's responsive rendering prop.
 */
export function deriveWidgetSize(h: number): WidgetSize {
  if (h >= 4) return 'full-width';
  if (h >= 3) return 'large';
  if (h >= 2) return 'medium';
  return 'small';
}

/** Absolute floor — no widget should be smaller than 2×2 grid units. */
const GLOBAL_MIN_W = 2;
const GLOBAL_MIN_H = 2;

interface GridMinSize {
  minW: number;
  minH: number;
}

/**
 * Compute minimum grid dimensions from a widget's declared supported sizes.
 *
 * The smallest supported size becomes the floor. Widgets can be freely
 * resized above this minimum but not below it.
 * @param definition - Widget definition (may be undefined for missing widgets).
 * @returns Minimum width and height in grid units.
 */
function minSizeFor(definition: WidgetDefinition | undefined): GridMinSize {
  if (!definition || definition.supportedSizes.length === 0) {
    return { minH: GLOBAL_MIN_H, minW: GLOBAL_MIN_W };
  }

  const dimensions = definition.supportedSizes.map((size) => SIZE_MAPPING[size]);
  return {
    minH: Math.max(GLOBAL_MIN_H, Math.min(...dimensions.map((d) => d.h))),
    minW: Math.max(GLOBAL_MIN_W, Math.min(...dimensions.map((d) => d.w))),
  };
}

/**
 * Convert widget placements into the layout format expected by react-grid-layout.
 *
 * Uses explicit `w`/`h` from the placement when available (set after a user
 * resize), falling back to the semantic `SIZE_MAPPING[size]` defaults for
 * placements that have never been manually resized. Per-widget minimum sizes
 * are derived from the widget definition's smallest supported size.
 *
 * Locked placements are always `static: true` regardless of `isEditing`.
 * @param layout - Persisted widget layout.
 * @param isEditing - Whether the dashboard is currently editable.
 * @param widgets - Widget definitions for minimum-size lookup.
 * @param applyGlobalMinH - When `false`, `GLOBAL_MIN_H` is not applied as a
 *   floor on `minH`. Pass `false` for fixed surfaces (e.g. the tray) that
 *   manage their own row-height authority and need to host widgets shorter
 *   than the responsive-dashboard minimum.
 * @returns Grid layout entries.
 */
function toResponsiveLayout(
  layout: WidgetLayout,
  isEditing: boolean,
  widgets: ReadonlyArray<WidgetDefinition>,
  applyGlobalMinH = true,
): Layout[] {
  return layout.placements.map((placement) => {
    const defaults = SIZE_MAPPING[placement.size] ?? SIZE_MAPPING.medium;
    const definition = widgets.find((w) => w.id === placement.widgetId);
    const { minH: minHFromDef, minW } = minSizeFor(definition);
    const minH = applyGlobalMinH ? minHFromDef : Math.min(minHFromDef, placement.h ?? defaults.h);

    return {
      h: placement.h ?? defaults.h,
      i: placement.instanceId,
      minH,
      minW,
      static: placement.locked === true || !isEditing,
      w: placement.w ?? defaults.w,
      x: placement.col - 1,
      y: placement.row - 1,
    };
  });
}

/**
 * Adapt a canonical layout (authored for 12 columns) to a smaller breakpoint.
 *
 * Widgets wider than the breakpoint's column count are clamped to fill the
 * available width. Minimum widths are clamped so items remain satisfiable.
 * Positions are clamped so widgets never overflow the grid.
 * @param items - Canonical layout items.
 * @param cols - Column count for the target breakpoint.
 * @returns Layout items adapted to the target column count.
 */
function adaptLayoutToBreakpoint(items: Layout[], cols: number): Layout[] {
  return items.map((item) => {
    const minW = item.minW === undefined ? undefined : Math.min(item.minW, cols);
    const w = Math.max(Math.min(item.w, cols), minW ?? 0);
    const x = Math.min(item.x, cols - w);
    return { ...item, minW, w, x };
  });
}

/**
 * Derive responsive layouts for all breakpoints from a canonical layout.
 *
 * The canonical layout is authored against the `lg` (12-column) grid.
 * Smaller breakpoints receive adapted copies where widget widths and
 * positions are clamped to fit.
 * @param canonical - Layout items for the 12-column grid.
 * @returns Layouts keyed by breakpoint name.
 */
function toResponsiveLayouts(canonical: Layout[]): Record<string, Layout[]> {
  const result: Record<string, Layout[]> = {};
  for (const [breakpoint, cols] of Object.entries(BREAKPOINT_COLS)) {
    result[breakpoint] = adaptLayoutToBreakpoint(canonical, cols);
  }
  return result;
}

/**
 * Build the fixed-grid layout for non-responsive surfaces.
 *
 * Fixed grids still use the canonical placement shape, so widths must be
 * clamped to the configured column count before reaching react-grid-layout.
 * @param layout - Persisted widget layout.
 * @param isEditing - Whether the dashboard is currently editable.
 * @param widgets - Widget definitions for minimum-size lookup.
 * @param cols - Column count for the fixed grid.
 * @returns Layout items adapted to the fixed grid width.
 */
export function toFixedLayout(
  layout: WidgetLayout,
  isEditing: boolean,
  widgets: ReadonlyArray<WidgetDefinition>,
  cols: number,
): Layout[] {
  return adaptLayoutToBreakpoint(toResponsiveLayout(layout, isEditing, widgets, false), cols);
}

/**
 * Merge react-grid-layout coordinates back into widget placements.
 *
 * Stores the actual grid dimensions (`w`, `h`) from the user interaction.
 * The semantic `size` is derived from the height so widgets receive a
 * meaningful responsive rendering hint without constraining the grid.
 * @param layout - Current persisted widget layout.
 * @param nextLayout - Layout emitted by react-grid-layout.
 * @returns Updated widget placements.
 */
function buildNextPlacements(layout: WidgetLayout, nextLayout: Layout[]): WidgetPlacement[] {
  const placementsById = new Map(layout.placements.map((placement) => [placement.instanceId, placement]));

  return nextLayout.reduce<WidgetPlacement[]>((result, item) => {
    const original = placementsById.get(item.i);
    if (item.i === '__dropping_elem__' || !original) {
      return result;
    }

    result.push({
      ...original,
      col: item.x + 1,
      h: item.h,
      row: item.y + 1,
      size: deriveWidgetSize(item.h),
      w: item.w,
    });
    return result;
  }, []);
}

/**
 * Render the interior of a widget grid tile.
 *
 * Separated from the outer `<div>` because react-grid-layout injects
 * positioning styles via `React.cloneElement` on its direct children.
 * The outer `<div key>` must be a plain element — never a component —
 * so RGL can attach `style`, `ref`, and `className` to it.
 *
 * The remove button and drag handle are suppressed for locked placements
 * even when the canvas is in edit mode.
 * @param props - Widget placement and editing state.
 * @returns Widget content with optional drag/remove chrome.
 */
function WidgetGridItemContent(props: {
  definition: WidgetDefinition;
  isEditing: boolean;
  layout: WidgetLayout;
  onLayoutChange: (layout: WidgetLayout) => void;
  onRemoveWidget: (instanceId: string) => void;
  placement: WidgetPlacement;
  uiContext: UiContextSnapshot;
  widgetContext: Record<string, Record<string, unknown>>;
}): JSX.Element {
  const { definition, isEditing, layout, onLayoutChange, onRemoveWidget, placement, uiContext, widgetContext } = props;
  const Widget = definition.component;

  return (
    <>
      {isEditing && !placement.locked ? (
        <>
          <div className={styles.dragHandle} />
          <button
            aria-label={`Remove widget ${definition.name}`}
            className={styles.removeButton}
            onClick={(event) => {
              event.stopPropagation();
              onRemoveWidget(placement.instanceId);
            }}
            title="Remove widget"
            type="button"
          >
            ×
          </button>
        </>
      ) : null}
      <div className={`${styles.widgetContent} ${isEditing ? styles.widgetContentEditing : ''}`}>
        <WidgetErrorBoundary widgetId={placement.widgetId}>
          <Widget
            config={{
              ...(definition.defaultConfig ?? {}),
              ...(placement.config ?? {}),
              ...(widgetContext[placement.widgetId] ?? {}),
            }}
            size={deriveWidgetSize(placement.h ?? SIZE_MAPPING[placement.size]?.h ?? 2)}
            uiContext={uiContext}
            updateConfig={(updates) => {
              const nextPlacements = layout.placements.map((currentPlacement) =>
                currentPlacement.instanceId === placement.instanceId
                  ? {
                      ...currentPlacement,
                      config: { ...currentPlacement.config, ...updates },
                    }
                  : currentPlacement,
              );

              onLayoutChange({
                ...layout,
                placements: nextPlacements,
              });
            }}
          />
        </WidgetErrorBoundary>
      </div>
    </>
  );
}

/**
 * Minimum pointer travel distance squared (px²) that counts as a drag, not a
 * click. Using squared distance avoids the `Math.sqrt` call on every click.
 */
const DRAG_THRESHOLD_SQ = 25; // 5px * 5px

/**
 * Selector for interactive elements that should not propagate their click up
 * to the activatable tile container. Clicking a button inside a widget should
 * perform the button's action, not open the overlay.
 */
const INTERACTIVE_ELEMENT_SELECTOR = 'button, a, input, select, textarea';

/**
 * Responsive grid that renders widget placements using react-grid-layout.
 * @param props - Grid configuration including layout, widgets, and edit-mode callbacks.
 * @returns Responsive grid with drag/resize support in edit mode.
 */
export const WidgetGrid: FC<WidgetGridProps> = ({
  layout,
  widgets,
  isEditing,
  onLayoutChange,
  onRemoveWidget,
  rowHeight = 80,
  uiContext = DEFAULT_WIDGET_UI_CONTEXT,
  widgetContext = {},
  droppingItem,
  onDrop,
  gridConfig,
}) => {
  // Compute only the layout shape required by the active branch. The
  // responsive branch needs per-breakpoint layouts; the fixed branch needs a
  // single flat array. Computing both on every render was dead work.
  const isFixed = gridConfig?.responsive === false;

  const bus = useOptionalBus();

  /**
   * Tracks the pointer-down position so we can suppress click events that
   * resulted from a drag gesture. A single ref is sufficient because only one
   * pointer is active at a time on a desktop grid.
   */
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const rglLayouts = useMemo(
    () => (isFixed ? null : toResponsiveLayouts(toResponsiveLayout(layout, isEditing, widgets))),
    [isFixed, isEditing, layout, widgets],
  );

  const fixedLayout = useMemo(
    () => (isFixed ? toFixedLayout(layout, isEditing, widgets, gridConfig.cols) : null),
    [gridConfig, isFixed, isEditing, layout, widgets],
  );

  /**
   * Persist layout changes only in response to explicit user interaction
   * (drag-end or resize-end). RGL's `onLayoutChange` fires on mount and
   * breakpoint transitions too, which would corrupt semantic sizes when
   * breakpoint column counts differ from the canonical grid.
   * @param nextLayout - Full layout array emitted by the RGL callback.
   */
  const handleUserLayoutChange = (nextLayout: Layout[]): void => {
    onLayoutChange({
      ...layout,
      placements: buildNextPlacements(layout, nextLayout),
    });
  };

  /**
   * Execute all declarative and custom activation side-effects for a widget.
   *
   * Called by both the click handler and the keyboard handler once it has been
   * determined that activation should proceed.
   * @param definition - Widget definition containing the `activate` spec.
   * @param placement - Widget instance being activated.
   */
  const executeActivation = (definition: WidgetDefinition, placement: WidgetPlacement): void => {
    const { activate } = definition;
    if (!activate) return;

    // Emit the activation event for observability.
    if (bus) {
      bus
        .emit(WidgetSubjects.activated, {
          instanceId: placement.instanceId,
          widgetId: placement.widgetId,
        })
        .catch((error: unknown) => {
          console.error('[WidgetGrid] Failed to emit widget.activated:', error);
        });
    }

    // Declarative: open a page in the current window.
    if (activate.pageId) {
      usePageOverlayStore.getState().openPage(activate.pageId);
    }

    void (async () => {
      if (activate.windowId && bus) {
        try {
          await bus.request(HostSubjects.window.create, { registrationId: activate.windowId });
        } catch (error: unknown) {
          console.error('[WidgetGrid] Failed to create window:', error);
        }
      }

      // Custom handler — runs after declarative steps.
      if (activate.onActivate && bus) {
        try {
          await activate.onActivate({
            bus,
            instanceId: placement.instanceId,
            widgetId: placement.widgetId,
          });
        } catch (error: unknown) {
          console.error('[WidgetGrid] Widget onActivate handler failed:', error);
        }
      }
    })();
  };

  /**
   * Build the click handler for an activatable widget tile.
   *
   * The handler is only created when the widget has an `activate` field and
   * the grid is not in edit mode. It guards against drag-generated clicks by
   * comparing the pointer-down and click positions.
   * @param definition - The widget definition containing the `activate` spec.
   * @param placement - The widget instance being clicked.
   * @returns A mouse-event handler, or undefined when activation is not applicable.
   */
  const buildActivationHandler = (
    definition: WidgetDefinition,
    placement: WidgetPlacement,
  ): ((event: MouseEvent<HTMLDivElement>) => void) | undefined => {
    if (isEditing || !definition.activate) {
      return undefined;
    }

    return (event: MouseEvent<HTMLDivElement>): void => {
      if ((event.target as Element).closest(INTERACTIVE_ELEMENT_SELECTOR)) {
        return;
      }

      // Suppress clicks that were generated by a drag gesture.
      if (pointerDownRef.current !== null) {
        const dx = event.clientX - pointerDownRef.current.x;
        const dy = event.clientY - pointerDownRef.current.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD_SQ) {
          return;
        }
      }

      executeActivation(definition, placement);
    };
  };

  /** Shared widget tile renderer for both responsive and fixed layouts. */
  const widgetTiles = layout.placements.map((placement) => {
    // Linear scan is fine here — dashboard widget count is O(10), not worth a Map.
    const definition = widgets.find((widget) => widget.id === placement.widgetId);

    if (!definition) {
      return (
        <div className={styles.missingWidget} key={placement.instanceId}>
          Widget definition not found: {placement.widgetId}
        </div>
      );
    }

    const isActivatable = !isEditing && Boolean(definition.activate);
    const handleActivation = buildActivationHandler(definition, placement);

    return (
      <div
        className={`${styles.widgetWrapper}${isActivatable ? ` ${styles.activatable}` : ''}`}
        key={placement.instanceId}
        onClick={handleActivation}
        onKeyDown={
          isActivatable
            ? (event: KeyboardEvent<HTMLDivElement>): void => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  executeActivation(definition, placement);
                }
              }
            : undefined
        }
        onPointerDown={
          isActivatable
            ? (event: PointerEvent<HTMLDivElement>) => {
                pointerDownRef.current = { x: event.clientX, y: event.clientY };
              }
            : undefined
        }
        role={isActivatable ? 'button' : undefined}
        tabIndex={isActivatable ? 0 : undefined}
      >
        <WidgetGridItemContent
          definition={definition}
          isEditing={isEditing}
          layout={layout}
          onLayoutChange={onLayoutChange}
          onRemoveWidget={onRemoveWidget}
          placement={placement}
          uiContext={uiContext}
          widgetContext={widgetContext}
        />
      </div>
    );
  });

  const gridClassName = `${styles.grid} ${isEditing ? styles.gridEditing : ''}`;

  if (gridConfig?.responsive === false) {
    const fixedRowHeight = gridConfig.rowHeight ?? rowHeight;
    const fixedMargin = gridConfig.margin ?? ([8, 8] as [number, number]);

    return (
      <div className={gridClassName} data-component="WidgetGrid">
        <GridLayout
          className="layout"
          cols={gridConfig.cols}
          compactType={null}
          droppingItem={droppingItem}
          isDraggable={isEditing}
          isDroppable={isEditing}
          isResizable={isEditing}
          layout={fixedLayout ?? []}
          margin={fixedMargin}
          onDragStop={(nextLayout) => handleUserLayoutChange(nextLayout)}
          onDrop={onDrop}
          onResizeStop={(nextLayout) => handleUserLayoutChange(nextLayout)}
          rowHeight={fixedRowHeight}
          width={gridConfig.width}
        >
          {widgetTiles}
        </GridLayout>
      </div>
    );
  }

  return (
    <div className={gridClassName} data-component="WidgetGrid">
      <ResponsiveGridLayoutWithWidth
        breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
        className="layout"
        cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
        compactType={null}
        droppingItem={droppingItem}
        isDraggable={isEditing}
        isDroppable={isEditing}
        isResizable={isEditing}
        layouts={rglLayouts ?? {}}
        margin={[16, 16]}
        onDragStop={(nextLayout) => handleUserLayoutChange(nextLayout)}
        onDrop={onDrop}
        onResizeStop={(nextLayout) => handleUserLayoutChange(nextLayout)}
        rowHeight={rowHeight}
      >
        {widgetTiles}
      </ResponsiveGridLayoutWithWidth>
    </div>
  );
};
