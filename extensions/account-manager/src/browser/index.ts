/**
 * Account Manager browser extension entry point.
 *
 * Default-exports an {@link ExtensionBrowserFactory} that returns the
 * account-manager browser contribution.
 *
 * Widgets contributed:
 * - `account-manager:tray-provider` — all providers and accounts for the tray.
 * - `account-manager:dashboard-accounts` — rich accounts overview for the dashboard.
 * - `account-manager:dashboard-usage` — KPI tiles and headroom bars for the dashboard.
 * - `account-manager:analytics-heatmap` — 7×24 usage heatmap for the analytics page.
 * - `account-manager:analytics-history` — multi-series time-series chart for the analytics page.
 * - `account-manager:analytics-distribution` — stacked window distribution bar for the analytics page.
 *
 * Pages contributed:
 * - `account-manager:analytics` — analytics page with range + account selectors.
 * - `account-manager:accounts` — full-screen accounts management page (sheet mode).
 *
 * Side-effect imports run at module evaluation time to register extension
 * scopes before the factory is called.
 * @packageDocumentation
 */

import './scopes.js';
import type { ExtensionBrowserContribution, ExtensionBrowserFactory } from '@makaio/ui-kernel';
import { registerExtensionBrowserFactory } from '@makaio/ui-kernel';
import {
  trayProviderWidgetDefinitionErased,
  dashboardAccountsWidgetDefinitionErased,
  dashboardUsageWidgetDefinitionErased,
  analyticsHeatmapWidgetDefinitionErased,
  analyticsHistoryWidgetDefinitionErased,
  analyticsDistributionWidgetDefinitionErased,
} from './widgets/index.js';
import { analyticsPageDeclaration, analyticsPageDefinition } from './pages/analytics/declaration.js';
import { accountsPageDefinition } from './pages/accounts/declaration.js';

/**
 * Account Manager browser contribution factory.
 *
 * Returns the complete account-manager UI contribution including the tray
 * provider widget, two dashboard widgets, three analytics widgets, the
 * analytics page layout declaration, the analytics page navigation
 * definition, and the accounts management page definition.
 * @returns Account Manager browser contribution.
 */
const contribution: ExtensionBrowserFactory = (): ExtensionBrowserContribution => ({
  pages: [analyticsPageDeclaration],
  pageDefinitions: [analyticsPageDefinition, accountsPageDefinition],
  widgets: [
    trayProviderWidgetDefinitionErased,
    dashboardAccountsWidgetDefinitionErased,
    dashboardUsageWidgetDefinitionErased,
    analyticsHeatmapWidgetDefinitionErased,
    analyticsHistoryWidgetDefinitionErased,
    analyticsDistributionWidgetDefinitionErased,
  ],
});

registerExtensionBrowserFactory('account-manager', contribution);

export default contribution;
