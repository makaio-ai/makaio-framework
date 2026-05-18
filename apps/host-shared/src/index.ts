export {
  HostNamespace,
  HostSubjects,
  HostSchemas,
  WindowStateSchema,
  type TrayActivateRequest,
  type TrayActivateResponse,
  type WindowClosedEvent,
  type WindowCreateRequest,
  type WindowCreateResponse,
  type WindowFocusRequest,
  type WindowFocusResponse,
  type WindowLabelChangedEvent,
  type WindowListRequest,
  type WindowListResponse,
  type WindowOpenedEvent,
  type WindowState,
} from '@makaio/contracts';
export {
  buildDevHostRuntimeOptions,
  buildDevHostRuntimeOptionsCore,
  HOST_WORKSPACE_ROOT_ENV,
  resolveDevHostOptions,
  resolveOptionalString,
  normalizeNodeHostCapabilities,
  assertPathInsideWorkspaceRoot,
  resolveOptionalPath,
  type DevHostDiscoveryFactoryOptions,
  type DevHostOptions,
  type DevHostOptionsResolveOptions,
  type DevHostRuntimeOptions,
} from './dev-host-options.js';
export { createDevHealthPlugin } from './dev-health-plugin.js';
export {
  DEFAULT_DESKTOP_MAKAIO_HOME_DIR,
  DESKTOP_MAKAIO_HOME_ENV,
  applyDesktopMakaioHomeEnv,
  createDesktopBootContext,
  resolveDesktopMakaioHome,
  type ApplyDesktopMakaioHomeEnvOptions,
  type CreateDesktopBootContextOptions,
  type DesktopBootContext,
  type ResolveDesktopMakaioHomeOptions,
} from './desktop-boot-context.js';
export {
  assertNoReservedWindowParams,
  registerHostNavigationHandler,
  resolveNavigation,
  type ResolvedNavigation,
} from './navigation-handler.js';
export {
  buildRendererLaunchUrl,
  createRendererLaunchConfig,
  encodeRendererParams,
  type BuildRendererLaunchUrlOptions,
  type CreateRendererLaunchConfigOptions,
  type RendererLaunchConfig,
} from './renderer-launch-config.js';
export {
  FRAMEWORK_FALLBACK_WINDOW,
  resolveInitialCustomData,
  resolveInitialWindowId,
  resolveInitialWindowState,
} from './startup-env.js';
export {
  loadWindowSession,
  saveWindowSession,
  type PersistedWindowEntry,
  type PersistedWindowSession,
  type WindowManagerState,
  type WindowSessionBounds,
  type WindowSessionBusClient,
  type WindowSessionLiveWindow,
  type WindowSessionScope,
  type WindowSessionWindowEntry,
  type WindowSessionWindowSource,
} from './window-session.js';
