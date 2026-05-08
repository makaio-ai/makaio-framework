/**
 * Core widget definitions and types
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { UiContextSnapshot } from '@makaio/contracts';
import type { WidgetScope } from './scope-registry.js';
import type { ComponentLike } from '../utils/component-types.js';

/** Framework fallback context when no host has selected a narrower context. */
export const DEFAULT_WIDGET_UI_CONTEXT: UiContextSnapshot = Object.freeze({
  level: 'root',
  values: Object.freeze({}),
});

/**
 * Values for widget size
 * 'small' | 'medium' | 'large' | 'full-width'
 */
export type WidgetSize = 'small' | 'medium' | 'large' | 'full-width';

/**
 * Props passed to all widget components
 */
export interface WidgetProps<TConfig = Record<string, unknown>> {
  /** Current size of the widget */
  size: WidgetSize;
  /** Widget instance configuration */
  config: TConfig;
  /** Callback to update configuration */
  updateConfig: (config: Partial<TConfig>) => void;
  /** Active host UI context for this widget surface. */
  uiContext: UiContextSnapshot;
}

/**
 * Context passed to a widget's custom activation handler.
 *
 * Provides everything the handler needs to perform side-effects: the bus for
 * further RPCs and the identity of the widget instance that was activated.
 */
export interface WidgetActivationContext {
  /** The MakaioBus instance for emitting events or issuing RPCs. */
  bus: IMakaioBus;
  /** Widget definition ID (same as `WidgetDefinition.id`). */
  widgetId: string;
  /** Widget instance ID within the current layout. */
  instanceId: string;
}

/**
 * Declarative activation behaviour for a widget.
 *
 * When a user clicks an activatable widget tile, the `WidgetGrid` evaluates
 * these fields in order:
 *
 * 1. `pageId` — Opens the named Page in the current window via
 *    `usePageOverlayStore.openPage`.
 * 2. `windowId` — Creates or focuses a named window via the
 *    `host.window.create` RPC.
 * 3. `onActivate` — Runs a custom async handler with full bus access.
 *
 * All three may be present; all will execute. Omit fields that are not needed.
 */
export interface WidgetActivation {
  /**
   * Page ID to open in the current window when the widget is activated.
   *
   * The Page's `mode` field determines how it is presented (e.g. `'sheet'`
   * for a fullscreen overlay). The `WidgetGrid` calls
   * `usePageOverlayStore.getState().openPage(pageId)`.
   */
  pageId?: string;
  /**
   * Window registration ID (format: `packageName:windowId`) to create or
   * focus when the widget is activated.
   *
   * The `WidgetGrid` issues a `host.window.create` RPC with this value as
   * the `registrationId`.
   */
  windowId?: string;
  /**
   * Custom activation handler called after declarative activation (if any).
   *
   * Receives a {@link WidgetActivationContext} with the bus, widgetId, and
   * instanceId. Runs after `pageId`/`windowId` activation so it can react to
   * the side-effects they produce.
   * @param ctx - Activation context with bus access and widget identity.
   * @returns A promise that resolves when the handler is complete.
   */
  onActivate?: (ctx: WidgetActivationContext) => Promise<void>;
}

/**
 * Definition of a widget available in the system
 */
export interface WidgetDefinition<TConfig = Record<string, unknown>> {
  /** Unique identifier for the widget type */
  id: string;
  /** Display name */
  name: string;
  /** Description shown in palette */
  description?: string;
  /**
   * Scope(s) where this widget can be used
   * - Single scope: 'global' or any host-registered scope
   * - Multiple scopes: ['global', '<host-scope>'] (Available in both contexts)
   */
  scope: WidgetScope | WidgetScope[];
  /**
   * React component implementing the widget.
   * Must accept WidgetProps.
   */
  component: ComponentLike<WidgetProps<TConfig>>;

  /**
   * Supported sizes. First one is default.
   */
  supportedSizes: WidgetSize[];

  /**
   * Default size when added
   */
  defaultSize: WidgetSize;

  /**
   * Optional size hint for the `'tray'` scope. If provided, `useTrayLayout`
   * uses this instead of `defaultSize` to choose the tray placement height.
   * Use this when a widget should render compactly in the tray (e.g. a
   * single-row status indicator) while remaining full-size on a dashboard.
   */
  trayDefaultSize?: WidgetSize;

  /**
   * Default configuration
   */
  defaultConfig?: TConfig;

  /**
   * Whether multiple instances of this widget are allowed
   */
  allowMultiple?: boolean;

  /**
   * Optional activation behaviour when the user clicks the widget tile.
   *
   * When present, the `WidgetGrid` renders the tile with a pointer cursor and
   * executes the declarative steps defined here on click (outside edit mode).
   * See {@link WidgetActivation} for the full dispatch sequence.
   */
  activate?: WidgetActivation;
}

/**
 * Erase the config type parameter for heterogeneous widget storage.
 *
 * `WidgetDefinition<TConfig>` is invariant in `TConfig`: `WidgetProps` has
 * `TConfig` in both covariant (`config`) and contravariant (`updateConfig`)
 * positions, so no single generic instantiation can accept all concrete
 * `WidgetDefinition<T>`. TypeScript lacks existential types, which is why the
 * registry keeps one explicit variance-boundary helper here.
 *
 * This generic utility provides a single, documented variance boundary.
 * TypeScript infers `T` from each call site — callers are fully type-safe.
 * At runtime, config values always flow as `Record<string, unknown>` through
 * the registry → layout → render pipeline.
 * @param definition - Concretely-typed widget definition
 * @returns The same definition typed for rendering with erased config
 */
export function eraseWidgetConfig<T extends Record<string, unknown>>(
  definition: WidgetDefinition<T>,
): WidgetDefinition {
  // @ts-expect-error -- Variance boundary: WidgetDefinition<T> → WidgetDefinition; structurally identical at runtime
  return definition;
}

export type { WidgetScope };

/**
 * Active widget instance in a layout
 */
export interface WidgetInstance {
  /** Unique ID for this widget instance */
  instanceId: string;
  /** ID of the widget definition */
  widgetId: string;
  /** Current size */
  size: WidgetSize;
  /** Instance specific configuration */
  config?: Record<string, unknown>;
}

/**
 * Identifiers for standard layout slots
 */
export type WidgetSlotId = 'main' | 'sidebar-left' | 'sidebar-right' | 'bottom';

/**
 * State of a single widget slot
 */
export interface WidgetSlotState {
  /** ID of the slot */
  id: WidgetSlotId;
  /** Widgets currently in this slot */
  widgets: WidgetInstance[];
}

/**
 * Widget placement in a grid.
 *
 * `size` is the semantic size used for default layout definitions and widget
 * palette drops. After a user resize, `w` and `h` store the actual grid
 * dimensions and take precedence over `SIZE_MAPPING[size]` for rendering.
 * The semantic `size` is re-derived from `w`/`h` for the widget's responsive
 * rendering prop.
 */
export interface WidgetPlacement {
  instanceId: string;
  widgetId: string;
  col: number;
  row: number;
  size: WidgetSize;
  /** Grid width in columns. When absent, derived from `size` via SIZE_MAPPING. */
  w?: number;
  /** Grid height in rows. When absent, derived from `size` via SIZE_MAPPING. */
  h?: number;
  config?: Record<string, unknown>;
  /** When true, the placement is non-removable and non-draggable regardless of edit mode. */
  locked?: boolean;
}

/**
 * Persisted widget layout
 */
export interface WidgetLayout {
  version: 1;
  placements: WidgetPlacement[];
}

const VALID_WIDGET_SIZES: ReadonlySet<WidgetSize> = new Set(['small', 'medium', 'large', 'full-width']);

/**
 * Narrow an unknown value to a plain record.
 * @param value - Unknown value to inspect.
 * @returns True when the value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Check whether a value is a finite number.
 * @param value - Unknown field value.
 * @returns True when the value is a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Runtime validator for persisted widget placements.
 * @param value - Candidate placement payload.
 * @returns True when the payload matches the widget placement contract.
 */
export function isWidgetPlacement(value: unknown): value is WidgetPlacement {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.instanceId !== 'string' ||
    typeof value.widgetId !== 'string' ||
    !isFiniteNumber(value.col) ||
    !isFiniteNumber(value.row) ||
    typeof value.size !== 'string' ||
    !VALID_WIDGET_SIZES.has(value.size as WidgetSize)
  ) {
    return false;
  }

  if (value.w !== undefined && !isFiniteNumber(value.w)) {
    return false;
  }

  if (value.h !== undefined && !isFiniteNumber(value.h)) {
    return false;
  }

  if (value.locked !== undefined && typeof value.locked !== 'boolean') {
    return false;
  }

  return value.config === undefined || isRecord(value.config);
}

/**
 * Runtime validator for persisted widget layouts.
 * @param value - Candidate layout payload.
 * @returns True when the payload matches the widget layout contract.
 */
export function isWidgetLayout(value: unknown): value is WidgetLayout {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.placements)) {
    return false;
  }

  return value.placements.every((placement) => isWidgetPlacement(placement));
}
