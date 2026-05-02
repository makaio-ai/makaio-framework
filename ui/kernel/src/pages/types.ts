/**
 * Page Registry Types
 *
 * Defines the data structures for page declarations, slots, and placements.
 * @packageDocumentation
 */

import type { WidgetSize, WidgetScope } from '../widgets/types.js';
import type { PageLevel } from './page-definition-types.js';
import type { IconComponentProps, LazyComponentModule } from '../utils/component-types.js';
export type { PageLevel } from './page-definition-types.js';

/**
 * Normalized slot identifiers.
 * Pages pick from this vocabulary - they don't invent custom names.
 */
export type SlotId = 'main' | 'sidebar-left' | 'sidebar-right' | 'detail-panel' | 'bottom-panel' | 'widget-zone';

/**
 * Slot definition - how a content area behaves.
 * All slots are grids with dynamic column calculation.
 */
export interface SlotDefinition {
  /** Normalized slot identifier */
  id: SlotId;

  /** Human-readable name for UI (e.g., "Main Content", "Details Panel") */
  name: string;

  /** Which widget sizes this slot accepts - used for compatibility filtering */
  acceptsSizes: WidgetSize[];

  /**
   * Minimum width per column in pixels.
   * Drives dynamic column count: cols = floor(width / minColumnWidth)
   */
  minColumnWidth: number;

  /** Maximum columns (cap for very wide slots) */
  maxColumns: number;

  /** Whether slot can be collapsed by user */
  collapsible?: boolean;

  /** Default collapsed state */
  defaultCollapsed?: boolean;
}

/**
 * Content that can be placed in a slot.
 * References widgets/views by ID - actual components resolved at runtime.
 */
export type SlotContent =
  | { type: 'view'; viewId: string; props?: Record<string, unknown> }
  | { type: 'widget'; widgetId: string; config?: Record<string, unknown> };

/**
 * Content placement with mandatory flag and optional position.
 */
export interface SlotPlacement {
  /**
   * Stable unique identifier for this placement instance.
   * Used as React key and for layout persistence.
   */
  instanceId: string;

  /** What to render */
  content: SlotContent;

  /** If true, user cannot remove this from the slot */
  mandatory: boolean;

  /**
   * Initial position in grid (col, row).
   * If omitted, auto-placed by grid layout engine.
   */
  position?: { col: number; row: number };
}

/**
 * Map of slot IDs to placements.
 */
export type SlotPlacementMap = Partial<Record<SlotId, SlotPlacement[]>>;

/**
 * Page declaration - registered by core or extensions.
 * Declarative definition of a page's structure and default content.
 */
export interface PageDeclaration {
  /**
   * Unique page identifier.
   * Framework pages: 'dashboard', 'settings'
   * Plugin pages: 'plugin-name:page-id' (namespaced)
   */
  id: string;

  /** Human-readable name */
  name: string;

  /** Description shown in page listings */
  description?: string;

  /**
   * Navigation level where this page is available.
   * - `'root'`: Only at the framework root level
   * - `'any'`: Available at all levels — matched by every `getByLevel()` query
   * - Host-specific levels are added through `UiNavigationLevelMap`
   *   declaration merging.
   *
   * If omitted, the page matches every level query when `includeAny` is true
   * (equivalent to setting `level: 'any'`).
   */
  level?: PageLevel;

  /**
   * Route path (for URL-based routing in web/ui).
   * Built-in: '/git', '/dashboard'
   * Plugin: '/extensions/<plugin-name>/<route>'
   * Optional - pages can exist without routes (focus-based only)
   */
  route?: string;

  /**
   * Widget scope for this page context.
   * Determines which widgets are available for the active UI context.
   * Hosts and extensions add domain scopes through `UiScopeMap` declaration merging.
   */
  scope: WidgetScope;

  /** Slots this page provides - uses normalized SlotId vocabulary */
  slots: SlotDefinition[];

  /** Default content per slot */
  defaultContent: SlotPlacementMap;

  /** Page-level icon for navigation (lazy-loaded) */
  icon?: () => Promise<LazyComponentModule<Pick<IconComponentProps, 'size'>>>;

  /** Page-level layout constraints */
  layout?: {
    /** Minimum page width before horizontal scroll */
    minWidth?: number;
  };
}

export type { WidgetScope, WidgetSize };
