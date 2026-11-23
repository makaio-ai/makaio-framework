/** @public */
export { KernelSchemas } from './namespace/index.js';
/** @public */
export { KernelNamespace } from './namespace/index.js';
export { KernelSubjects } from './namespace/index.js';

export { WindowRegistry, STYLE_DEFAULTS } from './window/index.js';
export type { WindowRegistration, WindowStyle } from './window/index.js';

export { EphemeralIdentityProvider, MemoryStorageProvider, NoTransportProvider } from './providers/index.js';
export type {
  IdentityProvider,
  MachineIdentity,
  StorageCleanup,
  StorageProvider,
  TransportProvider,
} from './providers/index.js';

export { BootNamespace, BootSubjects } from './boot-namespace.js';
export { ServiceSkipError } from './service-skip-error.js';
export { cancellationRejection, readCancellation } from './cancellation.js';
export { createShutdownSequence, runBoundedShutdownSteps, shutdownBudgetMs } from './shutdown.js';
export type { BoundedShutdownStep, ShutdownSequence } from './shutdown.js';

export type {
  ContributionProcessor,
  CredentialResolverBinder,
  ExtensionConfigResolution,
  ExtensionContextBase,
  ExtensionRuntimeSurface,
  KernelExtensionContext,
  KernelMakaioExtension,
  RuntimeCapability,
  RuntimeEnvironment,
  InstalledExtensionCatalogSource,
  SetEnabledResult,
  TransitionOutcome,
} from './extension/index.js';
export {
  ExtensionCoordinator,
  ExtensionOperatorConfigError,
  NamespaceCapabilityClosedError,
  coalesceExtensionOverrides,
  filterEligibleExtensions,
  resolveInstalledExtensionRecord,
} from './extension/index.js';

export {
  ComponentStateSchema,
  ExtensionInfoSchema,
  ExtensionNamespace,
  ExtensionSubjects,
  InstalledExtensionCatalogEntrySchema,
  InstalledExtensionRecordSchema,
  ServiceInfoSchema,
} from './observability/index.js';
/** @public */
export type {
  ComponentState,
  ComponentInfo,
  InstalledExtensionCatalogEntry,
  InstalledExtensionOrigin,
  InstalledExtensionRecord,
  ServiceInfo,
  ExtensionInfo,
  SetEnabledReason,
} from './observability/index.js';
