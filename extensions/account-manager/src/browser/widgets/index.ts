/**
 * Account-manager browser widget definitions barrel.
 *
 * Exports all widget definitions for the account-manager extension. The
 * type-erased variants (`*Erased`) are intended for use in the
 * `ExtensionBrowserContribution.widgets` array returned by the factory.
 * @packageDocumentation
 */

export {
  trayProviderWidgetDefinition,
  trayProviderWidgetDefinitionErased,
} from './tray-provider/tray-provider-widget.js';
export type { TrayProviderWidgetConfig } from './tray-provider/tray-provider-widget.js';

export {
  dashboardAccountsWidgetDefinition,
  dashboardAccountsWidgetDefinitionErased,
} from './dashboard-accounts/dashboard-accounts-widget.js';
export type { DashboardAccountsWidgetConfig } from './dashboard-accounts/dashboard-accounts-widget.js';

export {
  dashboardUsageWidgetDefinition,
  dashboardUsageWidgetDefinitionErased,
} from './dashboard-usage/dashboard-usage-widget.js';
export type { DashboardUsageWidgetConfig } from './dashboard-usage/dashboard-usage-widget.js';

export {
  analyticsHeatmapWidgetDefinition,
  analyticsHeatmapWidgetDefinitionErased,
} from './analytics-heatmap/analytics-heatmap-widget.js';
export type { AnalyticsHeatmapWidgetConfig } from './analytics-heatmap/analytics-heatmap-widget.js';

export {
  analyticsHistoryWidgetDefinition,
  analyticsHistoryWidgetDefinitionErased,
} from './analytics-history/analytics-history-widget.js';
export type { AnalyticsHistoryWidgetConfig } from './analytics-history/analytics-history-widget.js';

export {
  analyticsDistributionWidgetDefinition,
  analyticsDistributionWidgetDefinitionErased,
} from './analytics-distribution/analytics-distribution-widget.js';
export type { AnalyticsDistributionWidgetConfig } from './analytics-distribution/analytics-distribution-widget.js';
