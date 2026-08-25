/**
 * `@makaio/subsystem-adapter`
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

import type { IMakaioBus } from '@makaio/bus-core';
import { dep, extensionToken, type CapabilityToken, type MakaioNodeExtension } from '@makaio/contracts';
// Root barrel by necessity, not by preference: `SessionToken` is declared in the
// package's own composition module and has no narrower export. Naming a subpath
// that does not exist would be the change here, and adding one to publish a
// single token widens the package's public surface for a cosmetic import.
import { SessionToken } from '@makaio/services-core';
import { ADAPTER_SUBSYSTEM_PACKAGE_NAME, type IAdapterConfigRepository } from '@makaio/services-core/adapter-subsystem';
import type { ExtensionCoordinator } from '@makaio/kernel';
import { AdapterSubsystemService } from './adapter-subsystem-service.js';
import type { PlatformDefaults } from './adapter-runtime-lifecycle.js';
export { FileAdapterConfigRepository } from './config-repository.js';
export {
  ProviderConfigDiagnosticError,
  type ProviderConfigDiagnosticCode,
} from './provider-config-diagnostic-error.js';
export {
  assertProviderConfigAuthDefinitionsEnabled,
  ProviderConfigAuthValidationError,
  validateProviderConfigAuth,
  type ProviderConfigAuthValidationCode,
  type ValidatedProviderConfigAuth,
} from './provider-config-auth-validation.js';
export { ProviderRuntimeContextError, type ProviderRuntimeContextErrorCode } from './provider-runtime-view.js';

/**
 * Extension token for the adapter subsystem service.
 *
 * Built from the name declared alongside the subsystem's bus subjects, so a
 * framework package that must order itself after this one can name it without
 * importing the subsystem — which would invert the package layering.
 */
export const AdapterSubsystemToken = extensionToken<AdapterSubsystemService>(ADAPTER_SUBSYSTEM_PACKAGE_NAME);

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
  /** Trusted host-layer auth preparer forwarded opaquely to adapter factories. */
  readonly prepareAuthRuntime?: unknown;
  /** Priority for runtime snapshot handlers that must win before remote control-plane peers. */
  readonly runtimeSnapshotHandlerPriority?: number;
  /** Priority for provider/client definition reads backing local runtime snapshots. */
  readonly runtimeDefinitionHandlerPriority?: number;
}

/**
 * Create the adapter subsystem extension package.
 *
 * The returned package is critical and declares the `adapters` capability.
 * The composition root must register the contribution processor via
 * {@link createAdapterSubsystemContributionProcessor} before calling
 * `coordinator.startAll()` to ensure adapter contributions are processed in a
 * stable order.
 *
 * It declares the session package as a dependency because an adapter that
 * starts an agent must be able to reserve provider-session ownership first, and
 * the session package is what registers that authority. No new package edge is
 * created — `@makaio/services-core` is already a dependency of this subsystem —
 * only a declared start order, so a reserving adapter can never come up before
 * the authority it reserves from. The coordinator tears packages down in
 * reverse dependency order, which additionally puts adapter teardown before
 * session teardown.
 * @param options - Package-scoped dependencies including the coordinator.
 * @returns Critical Makaio extension for the adapter subsystem.
 */
export function createAdapterSubsystemPackage(
  options: CreateAdapterSubsystemPackageOptions,
): MakaioNodeExtension<IMakaioBus> {
  return {
    name: AdapterSubsystemToken.name,
    displayName: 'Adapter Subsystem',
    version: '0.1.0',
    provides: ['adapters'] satisfies readonly CapabilityToken[],
    dependencies: [dep(SessionToken.name)],
    critical: true,
    create: (ctx) => {
      const sessionService = ctx.getService(SessionToken);
      if (sessionService === undefined) {
        throw new Error('Adapter subsystem requires the active session ownership authority');
      }
      return new AdapterSubsystemService({
        bus: ctx.bus,
        configRepository: options.configRepository,
        coordinator: options.coordinator,
        machineId: ctx.machineId,
        resolveOwnerInstanceId: () => sessionService.requireOwnershipInstanceId(),
        platformDefaults: options.platformDefaults,
        ...(options.prepareAuthRuntime !== undefined && { prepareAuthRuntime: options.prepareAuthRuntime }),
        ...(options.runtimeSnapshotHandlerPriority !== undefined && {
          runtimeSnapshotHandlerPriority: options.runtimeSnapshotHandlerPriority,
        }),
        ...(options.runtimeDefinitionHandlerPriority !== undefined && {
          runtimeDefinitionHandlerPriority: options.runtimeDefinitionHandlerPriority,
        }),
      });
    },
  };
}

export { AdapterSubsystemService } from './adapter-subsystem-service.js';
export {
  contributesToAdapterSubsystem,
  createAdapterSubsystemContributionProcessor,
  orderAfterAdapterSubsystem,
} from './adapter-subsystem-contribution-factory.js';
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
  shutdownAdapterInstances,
  toAvailableAdapter,
} from './adapter-runtime-lifecycle.js';
export {
  AdapterInstanceCloseTimeoutError,
  aggregateAdapterInstanceTeardowns,
  classifyAdapterInstanceClose,
} from './adapter-instance-teardown.js';
export type {
  AdapterInstanceShutdownReport,
  AdapterInstanceTeardownResult,
} from './adapter-instance-teardown.js';
