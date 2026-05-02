/**
 * Analytics page declarations.
 *
 * Exports two complementary registrations for the analytics page:
 *
 * - {@link analyticsPageDeclaration} — slot-based layout metadata registered
 *   into {@link pageRegistry} via `ExtensionBrowserContribution.pages`.
 * - {@link analyticsPageDefinition} — navigation and rendering metadata
 *   registered into {@link pageDefinitionRegistry} via
 *   `ExtensionBrowserContribution.pageDefinitions`.
 *
 * Both use the same page ID so the navigation and layout systems resolve to
 * the same logical page.
 * @packageDocumentation
 */

import type { PageDeclaration, PageDefinition } from '@makaio/ui-kernel';
import AnalyticsIcon from './analytics-icon.js';

/** Shared page ID used by both the layout declaration and the navigation definition. */
const ANALYTICS_PAGE_ID = 'account-manager:analytics';

/**
 * Slot-based layout declaration for the analytics page.
 *
 * Registered in {@link pageRegistry}. Provides scope metadata and default
 * slot content for the `'account-manager:analytics'` widget scope.
 */
export const analyticsPageDeclaration: PageDeclaration = {
  id: ANALYTICS_PAGE_ID,
  name: 'Analytics',
  description: 'Usage trends across accounts',
  scope: 'account-manager:analytics',
  level: 'any',
  icon: () => import('./analytics-icon.js'),
  slots: [],
  defaultContent: {},
};

/**
 * Navigation definition for the analytics page.
 *
 * Registered in {@link pageDefinitionRegistry}. Provides the lazy-loaded
 * component, sidebar icon, and navigation mode so the page is routable and
 * renderable by the shell's page rendering system.
 */
export const analyticsPageDefinition: PageDefinition = {
  id: ANALYTICS_PAGE_ID,
  name: 'Analytics',
  description: 'Usage trends across accounts',
  icon: AnalyticsIcon,
  mode: 'switch',
  level: 'any',
  component: () => import('./analytics-page.js'),
  group: 'analytics',
  order: 20,
};
