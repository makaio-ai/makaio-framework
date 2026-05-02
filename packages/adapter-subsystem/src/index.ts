/**
 * `@makaio/adapter-subsystem`
 *
 * Framework-owned adapter subsystem service for file-backed adapter and
 * provider-config management.
 *
 * Adapter lifecycle is coordinator-driven: the composition root registers a
 * `ContributionProcessor` (via {@link createAdapterSubsystemContributionProcessor})
 * with the `ExtensionCoordinator` before `startAll()`, so adapter packages are
 * processed synchronously within `startAll()`, ensuring post-coordinator boot
 * phases run only after adapter contributions are registered and enabled
 * adapters are initialized.
 */

import { extensionToken, type CapabilityToken, type MakaioExtension } from '@makaio/contracts';
import type { IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import type { ExtensionCoordinator } from '@makaio/kernel';
import { AdapterSubsystemService } from './adapter-subsystem-service.js';
import type { PlatformDefaults } from './adapter-runtime-lifecycle.js';
export { FileAdapterConfigRepository } from './config-repository.js';

/** Extension token for the adapter subsystem service. */
export const AdapterSubsystemToken = extensionToken<AdapterSubsystemService>('adapter-subsystem');

/**
 * Options for creating the adapter subsystem extension package.
 */
export interface CreateAdapterSubsystemPackageOptions {
  /**
   * Repository seam used by the subsystem service for file-backed config storage.
   */
  readonly configRepository: IAdapterConfigRepository;
  /**
   * Extension coordinator forwarded to {@link AdapterContributionProcessor}.
   *
   * The composition root registers the contribution processor (via
   * {@link createAdapterSubsystemContributionProcessor}) with this coordinator
   * before `coordinator.startAll()` so adapter contributions run in a stable
   * order relative to other contribution processors.
   */
  readonly coordinator: ExtensionCoordinator;
  /**
   * Platform-provided defaults forwarded to adapter factories.
   */
  readonly platformDefaults: PlatformDefaults;
}

/**
 * Create the adapter subsystem extension package.
 *
 * The returned package is critical and declares the `adapters` capability.
 * The composition root must register the contribution processor via
 * {@link createAdapterSubsystemContributionProcessor} before calling
 * `coordinator.startAll()` to ensure adapter contributions are processed in a
 * stable order.
 * @param options - Package-scoped dependencies including the coordinator.
 * @returns Critical Makaio extension for the adapter subsystem.
 */
export function createAdapterSubsystemPackage(options: CreateAdapterSubsystemPackageOptions): MakaioExtension {
  return {
    name: AdapterSubsystemToken.name,
    displayName: 'Adapter Subsystem',
    provides: ['adapters'] satisfies readonly CapabilityToken[],
    critical: true,
    create: (ctx) =>
      new AdapterSubsystemService({
        bus: ctx.bus,
        configRepository: options.configRepository,
        coordinator: options.coordinator,
        machineId: ctx.machineId,
        platformDefaults: options.platformDefaults,
      }),
  };
}

export { AdapterSubsystemService } from './adapter-subsystem-service.js';
export { createAdapterSubsystemContributionProcessor } from './adapter-subsystem-contribution-factory.js';
export type { PlatformDefaults } from './adapter-runtime-lifecycle.js';
export type { IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';

export type {
  LoadedAdapter,
  AdapterInstance,
  AdapterInitOptions,
  AdapterLogImportConfig,
} from './adapter-runtime-types.js';
export {
  extractAdapterIdFromPackageName,
  ensureAdapterConfigs,
  initializeEnabledAdapters,
  shutdownAdapterInstances,
  toAvailableAdapter,
} from './adapter-runtime-lifecycle.js';
