export type {
  ContributionProcessor,
  ExtensionRuntimeSurface,
  KernelExtensionContext,
  KernelMakaioExtension,
  RuntimeCapability,
  RuntimeEnvironment,
} from './types.js';
/** @public */
export type { ExtensionCoordinatorOptions, InstalledExtensionCatalogSource } from './types.js';
export type { SetEnabledResult, TransitionOutcome } from './extension-toggle.js';
export { ExtensionCoordinator } from './extension-coordinator.js';
export { ExtensionOperatorConfigError } from './resolve-config.js';
export type { ExtensionConfigResolution } from './resolve-config.js';
export { coalesceExtensionOverrides, filterEligibleExtensions } from './extension-selection.js';
export { resolveInstalledExtensionRecord } from './installed-extension-catalog.js';
