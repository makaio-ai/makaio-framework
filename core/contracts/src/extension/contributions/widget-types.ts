import type { UiContextSnapshot, UiScope } from './ui-context-types.js';

/**
 * Widget size variants.
 *
 * Defines the visual footprint a widget can occupy in a layout.
 * - `'small'`: Minimal space, suitable for status indicators
 * - `'medium'`: Standard panel size, default for most widgets
 * - `'large'`: Expanded view, for detailed information
 * - `'full-width'`: Spans the full available width
 */
export type WidgetSize = 'small' | 'medium' | 'large' | 'full-width';

/**
 * Serializable widget definition.
 *
 * Platform-agnostic description of what data a widget needs and how it
 * behaves. This definition can be serialized and stored in user preferences.
 */
export interface WidgetDefinition {
  /**
   * Bus subject for the widget's data source.
   *
   * Optional — widgets can render without dynamic data (e.g. static controls).
   * When provided, the widget requests data from this subject.
   */
  dataSource?: string;
  /**
   * Events that trigger a widget refresh.
   *
   * List of bus event subjects that cause the widget to refresh its data.
   * @example `['session.updated', 'extension.stateChanged']`
   */
  refreshOn?: string[];
  /**
   * Supported size variants for this widget.
   *
   * Must include at least one size and must include `defaultSize`.
   */
  sizes: WidgetSize[];
  /**
   * Default size when the widget is first added to a layout.
   *
   * Must be one of the values in {@link sizes}.
   */
  defaultSize: WidgetSize;
}

/**
 * Props passed to widget components.
 * @typeParam TData - Type of data from the widget's data source, if any.
 */
export interface WidgetProps<TData = unknown> {
  /** The widget's definition (from declaration). */
  definition: WidgetDefinition;
  /** Current size of this widget instance. */
  size: WidgetSize;
  /** Data from the widget's data source (when `dataSource` is defined). */
  data?: TData;
  /** Active host UI context for this widget surface. */
  uiContext: UiContextSnapshot;
}

/**
 * Framework-agnostic UI component shape for lazy widget modules.
 *
 * Kept free of React imports so the contracts package does not force React
 * types onto non-web consumers. React function components are structurally
 * assignable to the call signature.
 */
type WidgetComponent = ((props: WidgetProps) => unknown) | (new (props: WidgetProps) => unknown);

/** Lazy widget component loader. */
type WidgetComponentLoader = () => Promise<{ default: WidgetComponent }>;

/**
 * Platform renderers for a widget.
 *
 * SEAM: Currently supports React; additional platforms can be added as optional
 * keys without breaking existing declarations.
 */
export interface WidgetRenderers {
  /**
   * React renderer for the web UI.
   *
   * Lazy-loaded component module with a default export that accepts
   * `WidgetProps<TData>` where `TData` matches the `dataSource` response.
   */
  react: WidgetComponentLoader;

  /**
   * SEAM: Future platform renderers (e.g. `reactNative`, `electron`).
   *
   * Additional platforms can be added here as optional keys.
   */
  [platform: string]: WidgetComponentLoader | undefined;
}

/**
 * Widget declaration contributed by a package.
 *
 * Packages declare widgets they provide. These are collected into a global
 * catalog that the UI system uses to populate focus contexts.
 * @example
 * ```typescript
 * const statusExtension: MakaioExtension = {
 *   name: 'status-panel',
 *   ui: {
 *     widgets: [
 *       {
 *         id: 'status-summary',
 *         name: 'Status Summary',
 *         description: 'Shows current runtime status',
 *         scope: 'global',
 *         definition: {
 *           dataSource: 'runtime.getStatus',
 *           refreshOn: ['runtime.ready', 'extension.stateChanged'],
 *           sizes: ['small', 'medium', 'large'],
 *           defaultSize: 'medium',
 *         },
 *         renderers: {
 *           react: () => import('./widgets/StatusSummary.js'),
 *         },
 *       },
 *     ],
 *   },
 * };
 * ```
 */
export interface WidgetDeclaration {
  /**
   * Unique widget identifier.
   *
   * Must be unique across all packages. Use the package name as a prefix to
   * avoid collisions.
   * @example `'status-summary'`, `'session-activity'`
   */
  id: string;
  /**
   * Display name for the widget.
   *
   * Human-readable name shown in UI when users browse available widgets.
   */
  name: string;
  /**
   * Optional description of widget purpose.
   *
   * Provides additional context about what the widget displays and when to
   * use it.
   */
  description?: string;
  /**
   * Widget scope identifier.
   *
   * Defaults to `'global'` when not specified.
   */
  scope?: UiScope;
  /**
   * Serializable widget definition.
   *
   * Describes the widget's data needs and behavior without platform-specific
   * details. Can be serialized and stored in user preferences.
   */
  definition: WidgetDefinition;
  /**
   * Platform-specific renderers.
   *
   * Maps platform names to lazy-loaded component modules. At minimum, the
   * `'react'` platform is required for the web UI.
   */
  renderers: WidgetRenderers;
}
