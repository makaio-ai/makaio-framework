/**
 * Type definitions for SplitPane component.
 *
 * These types mirror the layout types from the web-framework package
 * to avoid circular dependencies between components and framework packages.
 * @packageDocumentation
 */

/**
 * Content that can be displayed within a leaf pane.
 */
export type PaneContent =
  | { type: 'view'; viewId: string; props?: Record<string, unknown> }
  | { type: 'widget'; widgetId: string; instanceId: string; config?: Record<string, unknown> }
  | { type: 'panelSlot' }
  | { type: 'widgetSlot'; scope: string; defaultWidgets?: string[] }
  | { type: 'empty' };

/**
 * Size constraints for a pane.
 *
 * All size values are percentages (0-100).
 */
export interface PaneSizeConstraints {
  /**
   * Minimum size as percentage (0-100).
   */
  minSize?: number;

  /**
   * Maximum size as percentage (0-100).
   */
  maxSize?: number;

  /**
   * Default size as percentage (0-100).
   */
  defaultSize?: number;

  /**
   * Whether the pane can be collapsed to zero size.
   */
  collapsible?: boolean;
}

/**
 * Leaf pane containing actual content.
 */
export interface LeafPane {
  type: 'leaf';
  id: string;
  content: PaneContent;
  constraints?: PaneSizeConstraints;
}

/**
 * Split pane containing child panes arranged horizontally or vertically.
 *
 * The sizes array must have the same length as children and sum to 100.
 */
export interface SplitPane {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: Pane[];
  /**
   * Sizes as percentages (must sum to 100).
   */
  sizes: number[];
  constraints?: PaneSizeConstraints;
}

/**
 * Discriminated union of all pane types.
 */
export type Pane = LeafPane | SplitPane;
