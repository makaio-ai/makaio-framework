/**
 * Navigation Group Configuration
 *
 * Defines configuration for navigation groups including label and order.
 * Used to organize and sort pages in navigation UI.
 * @packageDocumentation
 */

import type { NavigationGroup } from './types.js';

/**
 * Configuration for a navigation group.
 *
 * Defines display label and sort order for groups in navigation UI.
 */
export interface NavigationGroupConfig {
  /** Navigation group identifier */
  readonly id: NavigationGroup;
  /** Display label for the group */
  readonly label: string;
  /** Sort order (lower appears first) */
  readonly order: number;
}

/**
 * Default navigation group configurations.
 *
 * Built-in groups for standard navigation patterns:
 * - `navigate`: Workspace-switching pages (Dashboard, Chat, Git)
 * - `analytics`: Analytics and reporting pages
 * - `quick-access`: Quick-access overlay pages (Settings, Projects, Sessions)
 */
export const defaultNavigationGroups: ReadonlyArray<NavigationGroupConfig> = Object.freeze([
  Object.freeze({ id: 'navigate', label: 'Navigate', order: 0 }),
  Object.freeze({ id: 'analytics', label: 'Analytics', order: 5 }),
  Object.freeze({ id: 'quick-access', label: 'Quick Access', order: 10 }),
]);
