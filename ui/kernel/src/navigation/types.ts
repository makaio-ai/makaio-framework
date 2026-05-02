/**
 * Navigation Registry Types
 *
 * Defines navigation targets - items that appear in navigation UI
 * (Quick Prompt, hover menus, breadcrumb dropdowns).
 *
 * Separate from PageRegistry (page structure/slots) to maintain SOC:
 * - Not all pages are navigable (embedded views, modals)
 * - Not all nav targets are pages (actions, commands, external links)
 * @packageDocumentation
 */

import type { UiNavigationLevel } from '@makaio/contracts';
import type { IconComponentLike } from '../utils/component-types.js';

/**
 * Navigation hierarchy level.
 *
 * Host products extend the available levels through `UiNavigationLevelMap`.
 * Framework-owned levels are `root` and `any`.
 */
export type NavigationLevel = UiNavigationLevel;

/**
 * Navigation action - what happens when a target is selected.
 *
 * The `focus` action uses a plain `string` focus context identifier.
 * (The `FocusContextId` branded type is intentionally not used at the kernel
 * tier — plain strings keep this tier portable across focus-context implementations.)
 */
export type NavigationAction =
  | { type: 'focus'; focusContext: string }
  | { type: 'page'; pageId: string }
  | { type: 'command'; commandId: string }
  | { type: 'callback'; handler: () => void }
  | { type: 'external'; url: string };

/**
 * Extensible navigation group map.
 *
 * Plugins extend via module augmentation:
 * ```typescript
 * declare module '@makaio/ui-kernel' {
 *   interface NavigationGroupMap {
 *     'my-plugin-section': true;
 *   }
 * }
 * ```
 */
export interface NavigationGroupMap {
  /** Workspace-switching pages (Dashboard, Chat, Git) */
  navigate: true;
  /** Analytics and reporting pages */
  analytics: true;
  /** Quick-access overlay pages (Settings, Projects, Sessions) */
  'quick-access': true;
}

/**
 * Navigation group identifier.
 * Type-safe via declaration merging of NavigationGroupMap.
 */
export type NavigationGroup = keyof NavigationGroupMap;

/**
 * Navigation target - an item that appears in navigation UI.
 *
 * Registered via NavigationRegistry and queried by navigation components
 * (KaiTrigger hover, Quick Prompt suggestions, breadcrumb dropdowns).
 */
export interface NavigationTarget {
  /** Unique identifier */
  id: string;

  /** Display label */
  label: string;

  /** Optional description for autocomplete/tooltips */
  description?: string;

  /** Icon component (lucide-react style) */
  icon?: IconComponentLike;

  /** Navigation level where this target is available */
  level: NavigationLevel;

  /** What happens on navigation */
  action: NavigationAction;

  /** Keyboard shortcut hint (display only, actual binding is separate) */
  shortcut?: string;

  /** Order in navigation list (lower = first, default = 50) */
  order?: number;

  /** Group for visual separation */
  group?: NavigationGroup;

  /**
   * Dynamic visibility condition.
   * Called when building navigation list - return false to hide.
   */
  when?: () => boolean;

  /**
   * Whether this target is currently active/selected.
   * Called when rendering - return true to show active state.
   */
  isActive?: () => boolean;
}

/**
 * Options for querying navigation targets.
 */
export interface NavigationQueryOptions {
  /** Filter by navigation level (includes 'any' targets) */
  level?: NavigationLevel;

  /** Filter by group */
  group?: NavigationGroup;

  /** Include targets where when() returns false */
  includeHidden?: boolean;
}
