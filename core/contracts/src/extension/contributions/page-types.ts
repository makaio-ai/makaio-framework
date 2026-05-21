import type { ComponentType } from 'react';
import type { UiNavigationLevel, UiScope } from './ui-context-types.js';

// WidgetSize and SlotId are intentionally local to keep page layout
// declarations serializable and independent from renderer-specific registries.

/**
 * Widget size values used for slot declarations in page layouts.
 */
export type WidgetSize = 'small' | 'medium' | 'large' | 'full-width';

/**
 * Normalized slot identifiers for page layout regions.
 */
export type SlotId = 'main' | 'sidebar-left' | 'sidebar-right' | 'detail-panel' | 'bottom-panel' | 'widget-zone';

/**
 * Page mode controlling sidebar navigation behavior.
 *
 * - `'switch'`: Takes over the workspace; shown in the sidebar "Navigate" section
 * - `'peek'`: Small overlay that preserves existing state
 * - `'cover'`: Full-viewport overlay that preserves existing state
 */
export type PageMode = 'switch' | 'peek' | 'cover';

/** Props passed to all page components. */
export interface PageComponentProps {
  /** Optional CSS class name for the page container. */
  className?: string;
  /** Current internal route within the page. */
  internalRoute?: string | null;
  /**
   * Callback for internal navigation within the page.
   * @param route - The new internal route path.
   */
  onNavigate?: (route: string) => void;
}

/** Slot definition for package declarations (fully serializable). */
export interface SlotDeclaration {
  /** Slot identifier. */
  id: SlotId;
  /** Human-readable slot name. */
  name: string;
  /** Sizes accepted by this slot. */
  acceptsSizes: WidgetSize[];
  /** Minimum column width in pixels. */
  minColumnWidth: number;
  /** Maximum number of columns. */
  maxColumns: number;
  /** Whether the slot can be collapsed. */
  collapsible?: boolean;
  /** Whether the slot starts collapsed. */
  defaultCollapsed?: boolean;
}

/** Content reference for a slot placement (view or widget). */
export type SlotContentDeclaration =
  | { type: 'view'; viewId: string; props?: Record<string, unknown> }
  | { type: 'widget'; widgetId: string; config?: Record<string, unknown> };

/** Placement declaration with a mandatory flag and optional position. */
export interface SlotPlacementDeclaration {
  /**
   * Stable unique identifier for this placement.
   *
   * Used as a React key and for layout persistence.
   */
  instanceId: string;
  /** Content reference for this placement. */
  content: SlotContentDeclaration;
  /** Whether this placement is mandatory (cannot be removed by the user). */
  mandatory: boolean;
  /** Optional grid position. */
  position?: { col: number; row: number };
}

/**
 * Page declaration for packages.
 *
 * Fully serializable — lazy-loads any custom components. To also register the
 * page in sidebar navigation (`PageDefinitionRegistry`), provide `mode`,
 * `level`, and `component`. The package loader will bridge this declaration to
 * a `PageDefinition` entry automatically.
 * @example
 * ```typescript
 * // Minimal page (slot-layout system only, no sidebar entry):
 * { id: 'my-page', name: 'My Page', scope: 'any', slots: [], defaultContent: {} }
 *
 * // Page with sidebar navigation entry:
 * {
 *   id: 'my-page',
 *   name: 'My Page',
 *   scope: 'any',
 *   mode: 'switch',
 *   level: 'any',
 *   component: () => import('./MyPage.js'),
 *   slots: [],
 *   defaultContent: {},
 * }
 * ```
 */
export interface PageDeclaration {
  /**
   * Unique page identifier.
   *
   * Will be namespaced to `'<package-name>:<page-id>'` by the loader.
   */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Optional description shown in page listings. */
  description?: string;
  /**
   * Route path relative to the package mount point.
   * @example `'dashboard'` becomes `/extensions/my-package/dashboard`
   */
  route?: string;
  /** UI scope for this page context. */
  scope: UiScope;
  /** Slot definitions for this page's layout. */
  slots: SlotDeclaration[];
  /** Default content per slot. */
  defaultContent: Partial<Record<SlotId, SlotPlacementDeclaration[]>>;
  /** Optional page-level icon (lazy-loaded). */
  icon?: () => Promise<{ default: ComponentType<{ size?: number }> }>;
  /** Optional page-level layout constraints. */
  layout?: {
    /** Minimum page width in pixels. */
    minWidth?: number;
  };
  /**
   * Navigation mode for sidebar registration.
   *
   * When provided alongside `level` and `component`, the package loader
   * registers this page in the sidebar navigation (`PageDefinitionRegistry`).
   * Omit to register in the slot-layout system only (`pageRegistry`).
   */
  mode?: PageMode;
  /**
   * Navigation level for sidebar registration.
   *
   * Required when `mode` is provided.
   */
  level?: UiNavigationLevel;
  /**
   * Lazy-loaded page component for sidebar navigation.
   *
   * Required when `mode` is provided. Must return a module with a default
   * export that accepts {@link PageComponentProps}.
   * @example
   * ```typescript
   * () => import('./MyPage.js').then(m => ({ default: m.MyPage }))
   * ```
   */
  component?: () => Promise<{ default: ComponentType<PageComponentProps> }>;
  /**
   * Display order in sidebar (lower = first).
   *
   * Only used when `mode` is provided. Defaults to `50` when omitted.
   */
  order?: number;
}
