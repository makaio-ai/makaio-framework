/**
 * Unified Page Definition Types
 *
 * Core type definitions for the unified page definition system where pages
 * are the single source of truth for "what pages exist" and "how they surface."
 *
 * This system replaces hardcoded page targets and switch statements with a
 * registry-driven approach.
 * @packageDocumentation
 */

import type { UiNavigationLevel } from '@makaio/contracts';
import type { PageSurfaceConfig, SurfaceId } from './schemas.js';
import type { NavigationGroup } from '../navigation/types.js';
import type { IconComponentLike, LazyComponentModule } from '../utils/component-types.js';

/**
 * Navigation level where a page is available.
 *
 * Host products extend the available levels through `UiNavigationLevelMap`.
 * Framework-owned levels are `root` and `any`.
 */
export type PageLevel = UiNavigationLevel;

/**
 * Page mode determines UI behavior when navigating to a page.
 *
 * - `switch`: Changes workspace focus. Page content takes over the main workspace area.
 *   Appears in sidebar "Navigate" section. Example: Home, Status, Chat pages.
 *
 * - `peek`: Opens as a constrained overlay that preserves workspace state underneath.
 *   Small modal (~800px). Example: Future pickers, quick-reference lookups.
 *
 * - `cover`: Opens as a full-viewport overlay that preserves workspace state underneath.
 *   Takes over the entire viewport including app shell. Example: Settings, Projects, Sessions.
 */
export type PageMode = 'switch' | 'peek' | 'cover';

/**
 * Check if a page mode uses the overlay system (pageOverlayStore).
 *
 * Both `peek` and `cover` modes open via the overlay store, while `switch`
 * changes workspace focus. This helper centralizes the mode classification
 * to avoid duplicating `mode === 'peek' || mode === 'cover'` checks.
 * @param mode - The page mode to check
 * @returns True if the mode opens an overlay (peek or cover)
 */
export function isOverlayMode(mode: PageMode): boolean {
  return mode === 'peek' || mode === 'cover';
}

/**
 * Props passed to all page components when rendered.
 *
 * This standardized interface ensures consistency across all page implementations,
 * whether built-in or plugin-provided.
 */
export interface PageComponentProps {
  /**
   * Optional CSS class name for the page container.
   * Applied to the root element of the page for custom styling.
   */
  className?: string;

  /**
   * Internal route within the page (for peek mode with sub-navigation).
   *
   * Example: For Settings page, this might be 'appearance' or 'extensions/example'
   * to navigate to specific settings sections.
   *
   * Defaults to null (no internal route, show default page view).
   */
  internalRoute?: string | null;

  /**
   * Callback for internal navigation within the page.
   *
   * Pages call this when user navigates between sub-sections (tabs, panels, etc.)
   * to update the URL and maintain navigation history.
   * @param route - The new internal route path
   */
  onNavigate?: (route: string) => void;
}

/**
 * Unified page definition — single source of truth for page identity,
 * navigation behavior, and rendering.
 *
 * Pages are defined as pure data in `web/pages` and registered into
 * PageDefinitionRegistry at app startup. This replaces hardcoded page
 * mappings and navigation targets.
 * @example
 * ```typescript
 * import { Settings } from 'lucide-react';
 *
 * export const settingsPageDefinition: PageDefinition = {
 *   id: 'settings',
 *   name: 'Settings',
 *   description: 'Application settings and configuration',
 *   icon: Settings,
 *   mode: 'peek',
 *   level: 'any',
 *   component: () => import('@makaio/ui-views').then(m => ({ default: m.SettingsView })),
 *   group: 'quick-access',
 *   order: 100,
 *   shortcut: '⌘,',
 * };
 * ```
 */
export interface PageDefinition {
  /**
   * Unique page identifier.
   *
   * Built-in pages use simple IDs: 'settings', 'sessions', 'home'
   * Plugin pages use namespaced IDs: 'plugin-name:page-id'
   * @example 'settings'
   * @example 'example-plugin:details'
   */
  id: string;

  /**
   * Display name for sidebar, slash command, overlay title.
   *
   * Keep concise (1-2 words) for sidebar display.
   * @example 'Settings'
   * @example 'Runtime Status'
   */
  name: string;

  /**
   * Description for autocomplete tooltips and slash command suggestions.
   *
   * Shown in Quick Prompt suggestions and sidebar tooltips.
   * One sentence describing what the page does.
   * @example 'Application settings and configuration'
   */
  description?: string;

  /**
   * Icon component for sidebar and command palette.
   *
   * Use lucide-react icons directly (sync import).
   * Icons are tree-shaken and tiny, no need for lazy loading.
   * @example Settings (from 'lucide-react')
   */
  icon?: IconComponentLike;

  /**
   * Page mode determines navigation behavior.
   *
   * - `switch`: Takes over workspace, shows in "Navigate" section
   * - `peek`: Small overlay preserving state, shows in "Quick Access" section
   * - `cover`: Full-viewport overlay preserving state, shows in "Quick Access" section
   */
  mode: PageMode;

  /**
   * Navigation level where this page is available.
   *
   * Pages with `level: 'any'` are always available.
   * Pages with specific levels only appear when that context is active.
   *
   * The query system automatically includes 'any' pages when filtering by level.
   * @example 'any' - Settings available everywhere
   * @example 'root' - Root shell pages
   */
  level: PageLevel;

  /**
   * Lazy-loaded page component for code splitting.
   *
   * Must return a module with a default export that accepts PageComponentProps.
   * Use dynamic import for automatic code splitting.
   * @example
   * ```typescript
   * () => import('./SettingsView.js').then(m => (\{ default: m.SettingsView \}))
   * ```
   */
  component: () => Promise<LazyComponentModule<PageComponentProps>>;

  /**
   * Display order in sidebar (lower = first).
   *
   * Applied automatically during registration if omitted (defaults to 50).
   */
  order?: number;

  /**
   * Navigation group for sidebar visual organization.
   *
   * Groups create visual separation in navigation UI.
   * Applied automatically during registration if omitted (defaults to 'navigate').
   */
  group?: NavigationGroup;

  /**
   * Keyboard shortcut hint (display-only).
   *
   * Shown in sidebar and tooltips. Actual keyboard binding
   * is registered separately through the keybinding system.
   * @example '⌘,' - Command+Comma for Settings
   * @example '⌘S' - Command+S for Search
   */
  shortcut?: string;

  /**
   * Dynamic visibility condition.
   *
   * Called when building navigation lists. Return false to hide
   * the page from sidebar and command palette.
   *
   * Use for feature flags, permission checks, or context-dependent availability.
   * @returns True to show the page, false to hide it
   * @example
   * ```typescript
   * () => featureFlags.pageEnabled
   * ```
   */
  when?: () => boolean;

  /**
   * Whether this page is currently active/selected.
   *
   * Called when rendering sidebar to show active indicator.
   * Used for visual feedback of current page.
   * @returns True to show active state, false otherwise
   * @example
   * ```typescript
   * () => focusStore.getState().activeFocus.id === 'settings'
   * ```
   */
  isActive?: () => boolean;

  /**
   * Focus context identifier for switch-mode pages.
   *
   * When set, switching to this page sets the active focus context.
   * Only relevant for mode='switch' pages.
   * Plain string (not a branded FocusContextId) for kernel-tier portability.
   * @example 'chat' - Switching to chat page activates chat focus context
   * @example 'settings' - Switching to settings page activates settings focus context
   */
  focusContext?: string;

  /**
   * Extract the active section ID from an internal route.
   *
   * Used by PageCoverView to highlight the active sidebar entry
   * when the page has registered sections in PageSectionRegistry.
   * Return null for overview/non-section routes.
   * @param internalRoute - The current internal route (e.g., '/settings/relay')
   * @returns Section ID if route maps to a section, null otherwise
   * @example
   * ```typescript
   * // Settings page: /settings/relay → 'relay', /settings/adapters/openai → null
   * parseSectionId: (route) => {
   *   if (!route) return null;
   *   const match = route.match(/^\/settings\/([^/]+)$/);
   *   return match?.[1] ?? null;
   * }
   * ```
   */
  parseSectionId?: (internalRoute: string | null) => string | null;

  /**
   * Surface visibility configuration.
   *
   * Controls which rendering surfaces (web, mobile, electron) can display this page.
   * Uses either explicit surface IDs or capability requirements.
   * - Omitted: available on every surface (backward-compatible default)
   * - `{ surfaces: ['web'] }`: web only
   * - `{ surfaces: ['mobile'] }`: mobile only
   * - `{ requiredCapabilities: ['dom'] }`: any surface with DOM access
   * @example
   * ```typescript
   * { surfaces: ['web', 'electron'] } // Web and desktop only
   * ```
   * @example
   * ```typescript
   * { requiredCapabilities: ['touch'] } // Touch-capable surfaces
   * ```
   */
  surface?: PageSurfaceConfig;

  /**
   * Which Electron window(s) this page appears in, identified by qualified
   * registration ID (`{packageName}:{windowId}`).
   *
   * When omitted or `undefined`, the page is visible in all windows.
   * Accepts a single ID or an array for pages shared across multiple windows.
   * @example
   * ```typescript
   * windowId: 'makaio.workspace-window:main' // Only in workspace windows
   * ```
   * @example
   * ```typescript
   * windowId: ['makaio.workspace-window:main', 'makaio.chat:main'] // Multiple windows
   * ```
   */
  windowId?: string | string[];
}

/**
 * Query options for filtering page definitions.
 *
 * All filters are optional and combine with AND logic.
 * Level filter automatically includes pages with level='any'.
 */
export interface PageDefinitionQueryOptions {
  /**
   * Filter by page mode.
   * @example
   * ```typescript
   * \{ mode: 'peek' \} // Only overlay pages
   * ```
   */
  mode?: PageMode;

  /**
   * Filter by navigation level.
   * Automatically includes pages with level='any'.
   * @example
   * ```typescript
   * \{ level: 'root' \} // Root and 'any' pages
   * ```
   */
  level?: PageLevel;

  /**
   * Filter by navigation group.
   * @example
   * ```typescript
   * \{ group: 'quick-access' \} // Only quick access pages
   * ```
   */
  group?: NavigationGroup;

  /**
   * Filter by rendering surface.
   *
   * When set, only pages available on this surface are returned.
   * Pages with `surface` omitted are always included (available everywhere).
   * Pages that declare only `requiredCapabilities` are excluded — a SurfaceId
   * alone is not sufficient to evaluate capability requirements. Use
   * `isPageVisibleOnSurface(page, surfaceDeclaration)` at the surface runtime to
   * include capability-gated pages with their full capability set.
   * @example
   * ```typescript
   * \{ surface: 'mobile' \} // Pages available on mobile
   * ```
   */
  surface?: SurfaceId;

  /**
   * Include pages where when() returns false.
   *
   * Defaults to false (hidden pages excluded from results).
   */
  includeHidden?: boolean;
}
