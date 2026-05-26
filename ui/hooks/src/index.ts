/**
 * \@makaio/ui-hooks — React hooks, Zustand stores, context providers, bus-aware React code.
 *
 * Depends on `\@makaio/ui-kernel` for pure registries/contracts, `\@makaio/bus-core` for
 * bus access, and `\@makaio/contracts` for subjects/types.
 *
 * Layer rule: hooks MUST NOT import from `\@makaio/ui-views` or `\@makaio/ui-components`.
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Bus provider
// ---------------------------------------------------------------------------
export { BusProvider, BusContext, useBus, useOptionalBus } from './bus/bus-provider.js';
export type { BusProviderProps } from './bus/bus-provider.js';

export { useBusQuery } from './bus/use-bus-query.js';
export type { UseBusQueryOptions, UseBusQueryResult } from './bus/use-bus-query.js';

export { useBusEvent } from './bus/use-bus-event.js';

// ---------------------------------------------------------------------------
// Widget hooks
// ---------------------------------------------------------------------------
export { useWidgets, useWidgetRegistry, useWidgetConfig } from './widgets/hooks.js';
export type {
  UseWidgetsOptions,
  UseWidgetsResult,
  UseWidgetRegistryOptions,
  UseWidgetConfigOptions,
  UseWidgetConfigResult,
} from './widgets/hooks.js';

export { useWidgetLayout } from './widgets/use-widget-layout.js';
export { useWidgetLayoutActions } from './widgets/use-widget-layout-actions.js';
export { useTrayLayout } from './widgets/use-tray-layout.js';

// ---------------------------------------------------------------------------
// Extension browser loader
// ---------------------------------------------------------------------------
export { loadExtensionBrowserContributions } from './extensions/shared-browser-loader.js';
export type {
  SharedLoaderState,
  ExtensionBrowserLoadResult,
  ExtensionBrowserLoadOptions,
} from './extensions/shared-browser-loader.js';

// ---------------------------------------------------------------------------
// State stores
// ---------------------------------------------------------------------------
export { createPersistedStore, noopStorage } from './state/create-persisted-store.js';
export type { StorageType, PersistedStoreConfig } from './state/create-persisted-store.js';

export { useWindowContext } from './state/window-context-store.js';
export type { WindowContextState } from './state/window-context-store.js';

export { usePageOverlayStore } from './state/page-overlay-store.js';
export type { PageOverlayState } from './state/page-overlay-store.js';

export { useSidebarStore } from './state/sidebar-store.js';
export type { SidebarState } from './state/sidebar-store.js';

export { useFocusStore } from './state/focus-store.js';
export type { FocusState, FocusContextId, FocusContextObject } from './state/focus-store.js';

// ---------------------------------------------------------------------------
// Focus context widget layout types
// ---------------------------------------------------------------------------
export type { FocusContextLayout, PlacedFocusWidget, FocusContextWidgetSize } from './types/widget-layout.js';
export {
  createEmptyFocusContextLayout,
  addWidgetToFocusLayout,
  removeWidgetFromFocusLayout,
  updateFocusContextWidgetSize,
  updateFocusContextWidgetPosition,
} from './types/widget-layout.js';

// ---------------------------------------------------------------------------
// Navigation hooks
// ---------------------------------------------------------------------------
export { useNavigationLevel } from './navigation/use-navigation-level.js';
export type { RuntimeNavigationLevel } from './navigation/use-navigation-level.js';

export { registerNavigationHandler } from './navigation/register-navigation-handler.js';

export { groupPagesByNavigationGroup } from './navigation/group-pages.js';
export type { GroupedPages } from './navigation/group-pages.js';

// ---------------------------------------------------------------------------
// Page hooks
// ---------------------------------------------------------------------------
export { usePageDefinitions } from './pages/use-page-definitions.js';
export { usePages } from './pages/use-pages.js';
export type { ExecutablePage } from './pages/use-pages.js';
export { useWindowIdPages } from './pages/use-window-id-pages.js';
export { usePageComponent } from './pages/use-page-component.js';

// ---------------------------------------------------------------------------
// Onboarding hooks
// ---------------------------------------------------------------------------
export {
  registerCoreOnboardingSteps,
  type CoreOnboardingStepComponents,
} from './onboarding/register-core-onboarding-steps.js';

export {
  getOnboardingSkipped,
  setOnboardingSkipped,
  clearOnboardingSkipped,
  getOnboardingCompleted,
  setOnboardingCompleted,
  clearOnboardingCompleted,
} from './onboarding/skip-flag.js';

export { useOnboardingFlow } from './onboarding/use-onboarding-flow.js';

export type {
  HealthCheckResult,
  OnboardingStepDefinition,
  OnboardingFlowState,
  OnboardingFlowActions,
  OnboardingStepProps,
  UseOnboardingFlowOptions,
  UseOnboardingFlowResult,
} from './onboarding/types.js';

export type { PersistedExtensionConfigEntry } from './onboarding/plugin-persistence.js';
export { persistPluginEnabled } from './onboarding/plugin-persistence.js';

export type { OnboardingAdapter, OnboardingClient, ScanContext } from './onboarding/scan-onboarding-adapters.js';

export {
  scanOnboardingAdapters,
  scanOnboardingClients,
  scanOnboarding,
  buildScanContext,
} from './onboarding/scan-onboarding-adapters.js';

// ---------------------------------------------------------------------------
// Application context and provider stores
// ---------------------------------------------------------------------------
export { useAppContext } from './state/app-context-store.js';
export type { AppContextState } from './state/app-context-store.js';

export { useProviderStore } from './state/provider-store.js';
export type { ProviderInfo, BoundAdapter } from './state/provider-store.js';

// ---------------------------------------------------------------------------
// Provider-config selectors
// ---------------------------------------------------------------------------
export { listProviderConfigSummaryViews, getProviderConfigDetailView } from './provider-config/selectors.js';
export type { ProviderConfigSummaryView, ProviderConfigDetailView } from './provider-config/selectors.js';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
export { parsePersistedAgentSelection, isPersistableProjectSelection } from './utils/persisted-agent-selection.js';
export type { PersistableAdapterSelection, PersistableProjectSelection } from './utils/persisted-agent-selection.js';
