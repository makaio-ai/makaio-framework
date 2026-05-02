/**
 * \@makaio/ui-kernel — pure registries and contracts.
 *
 * No React runtime. No DOM APIs. No hooks. No JSX.
 * React component typing is centralized in `utils/component-types`.
 *
 * Exports the framework-tier registries, types, and pure utilities that
 * ui-hooks, ui-components, and ui-views all depend on.
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Widget infrastructure
// ---------------------------------------------------------------------------
export {
  widgetScopeRegistry,
  type WidgetScopeDefinition,
  type WidgetScope,
  widgetMatchesScope,
} from './widgets/scope-registry.js';

export {
  type WidgetProps,
  type WidgetDefinition,
  type WidgetInstance,
  type WidgetSlotId,
  type WidgetSlotState,
  type WidgetPlacement,
  type WidgetLayout,
  type WidgetSize,
  DEFAULT_WIDGET_UI_CONTEXT,
  isWidgetPlacement,
  isWidgetLayout,
  eraseWidgetConfig,
} from './widgets/types.js';

export { WidgetRegistry, widgetRegistry } from './widgets/WidgetRegistry.js';

export {
  WidgetSchemas,
  WidgetRawSchemas,
  type WidgetDefinitionPayload,
  type UnregisterPayload,
  type ListWidgetsRequest,
  type ListWidgetsResponse,
} from './widgets/schemas.js';

export { WidgetNamespace, WidgetSubjects } from './widgets/namespace.js';

export { deriveTrayLayout } from './widgets/tray-layout.js';

export { registerWidget, registerWidgets, unregisterWidget } from './widgets/register.js';

export { subscribeToWidgetEvents } from './widgets/subscriptions.js';

// ---------------------------------------------------------------------------
// Extension infrastructure
// ---------------------------------------------------------------------------
export {
  registerExtensionBrowserFactory,
  unregisterExtensionBrowserFactory,
  clearExtensionBrowserFactories,
  getRegisteredExtensionBrowserFactory,
} from './extensions/browser-factory-registry.js';

export {
  resolveExtensionBrowserFactory,
  type ExtensionBrowserFactoryResolution,
} from './extensions/browser-factory-resolution.js';

export { runCleanupsInReverse } from './extensions/cleanup-stack.js';

export { registerExtensionUI } from './extensions/registration-utils.js';

export { SHELL_BG_COLOR, SHELL_TEXT_COLOR, SHELL_FONT_FAMILY } from './extensions/shell-style.js';

export type {
  ShellProps,
  ShellContribution,
  ExtensionBrowserContribution,
  ExtensionBrowserFactory,
  ExtensionBrowserFactoryContext,
} from './extensions/types.js';

// ---------------------------------------------------------------------------
// Runtime readiness
// ---------------------------------------------------------------------------
export {
  createRuntimeReadyWaiter,
  type RuntimeReadyWaiter,
  type RuntimeReadyWaitResult,
} from './runtime/wait-for-runtime-ready.js';

// ---------------------------------------------------------------------------
// Page infrastructure
// ---------------------------------------------------------------------------
export {
  type PageLevel,
  type PageMode,
  type PageComponentProps,
  type PageDefinition,
  type PageDefinitionQueryOptions,
  isOverlayMode,
} from './pages/page-definition-types.js';

export {
  type SlotId,
  type SlotDefinition,
  type SlotContent,
  type SlotPlacement,
  type SlotPlacementMap,
  type PageDeclaration,
} from './pages/types.js';

export {
  type PageSectionProps,
  type PageSectionStatus,
  type PageSectionDefinition,
} from './pages/page-section-types.js';

export {
  PageDefinitionRegistry,
  pageDefinitionRegistry,
  queryPageDefinitions,
} from './pages/PageDefinitionRegistry.js';
export { PageRegistry, pageRegistry } from './pages/PageRegistry.js';
export { PageSectionRegistry, pageSectionRegistry } from './pages/PageSectionRegistry.js';

export { registerPageBusHandler } from './pages/registerPageBusHandler.js';

export {
  buildPageLayoutKey,
  PAGE_PREFERENCE_CATEGORIES,
  type PageLayoutPersistenceContext,
} from './pages/persistence.js';

// ---------------------------------------------------------------------------
// Navigation infrastructure
// ---------------------------------------------------------------------------
export {
  type NavigationLevel,
  type NavigationAction,
  type NavigationGroupMap,
  type NavigationGroup,
  type NavigationTarget,
  type NavigationQueryOptions,
} from './navigation/types.js';

export { NavigationRegistry, navigationRegistry } from './navigation/NavigationRegistry.js';

export { type NavigationGroupConfig, defaultNavigationGroups } from './navigation/navigation-group-config.js';

export { deriveBrowserTarget } from './navigation/deriveBrowserTarget.js';

export { UiSchemas } from './navigation/ui-schemas.js';
export type {
  UiReadyEvent,
  UiNavigateRequest,
  UiNavigateResponse,
  UiNavigateAction,
  UiPopoverShowRequest,
  UiPopoverShowResponse,
  UiShortcutTriggeredEvent,
} from './navigation/ui-schemas.js';
export { UiNamespace, UiSubjects } from './navigation/ui-namespace.js';

// ---------------------------------------------------------------------------
// Onboarding infrastructure
// ---------------------------------------------------------------------------
export {
  type OnboardingKaiState,
  type AdapterInfo,
  type OnboardingContext,
  type OnboardingStepProps,
  type OnboardingStepDefinition,
} from './onboarding/types.js';

export { OnboardingStepRegistry, onboardingStepRegistry } from './onboarding/OnboardingStepRegistry.js';

export {
  type PluginCategory,
  PLUGIN_CATEGORIES,
  deriveDefaultEnabled,
  findCategory,
} from './onboarding/plugin-categories.js';

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------
export type {
  ComponentLike,
  IconComponentLike,
  IconComponentProps,
  LazyComponentModule,
} from './utils/component-types.js';
export { RegistryBase } from './utils/RegistryBase.js';

// ---------------------------------------------------------------------------
// Tray configuration
// ---------------------------------------------------------------------------
export {
  TRAY_CANVAS_HORIZONTAL_PADDING_PX,
  TRAY_CELL_MARGIN,
  TRAY_GRID_COLS,
  TRAY_GRID_WIDTH_PX,
  TRAY_ROW_HEIGHT_PX,
  TRAY_WINDOW_HEIGHT_PX,
  TRAY_WINDOW_WIDTH_PX,
} from './tray-config.js';
