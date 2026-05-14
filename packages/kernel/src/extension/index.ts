export type {
  ContributionProcessor,
  ExtensionRuntimeSurface,
  KernelExtensionContext,
  KernelMakaioExtension,
  RuntimeCapability,
  RuntimeEnvironment,
} from './types.js';
/** @public */
export type { ExtensionCoordinatorOptions } from './types.js';
export { ExtensionCoordinator } from './extension-coordinator.js';
export { coalesceExtensionOverrides, filterEligibleExtensions } from './extension-selection.js';
