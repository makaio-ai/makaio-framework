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
export { createShutdownSequence } from './shutdown.js';

export type {
  ContributionProcessor,
  ExtensionRuntimeSurface,
  KernelExtensionContext,
  KernelMakaioExtension,
  RuntimeCapability,
  RuntimeEnvironment,
} from './extension/index.js';
export { ExtensionCoordinator, coalesceExtensionOverrides, filterEligibleExtensions } from './extension/index.js';

export {
  ComponentStateSchema,
  ExtensionInfoSchema,
  ExtensionNamespace,
  ExtensionSubjects,
  ServiceInfoSchema,
} from './observability/index.js';
/** @public */
export type { ComponentState, ComponentInfo, ServiceInfo, ExtensionInfo } from './observability/index.js';
