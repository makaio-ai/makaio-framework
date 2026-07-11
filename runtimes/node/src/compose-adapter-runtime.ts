import type { IMakaioBus } from '@makaio/bus-core';
import type { ExtensionCoordinator } from '@makaio/kernel';
import {
  AdapterSubsystemToken,
  createAdapterSubsystemPackage,
  createAdapterSubsystemContributionProcessor,
  type IAdapterConfigRepository,
  type PlatformDefaults,
} from '@makaio/subsystem-adapter';
import { registerAdapterRuntimeIdentityHandlers } from '@makaio/services-core/adapter-runtime';
import { AdapterSubsystemSubjects } from '@makaio/services-core/adapter-subsystem';
import { registerAdapterNameResolver } from './register-adapter-name-resolver.js';

/**
 * Composition seam for booting a local adapter runtime.
 *
 * Encapsulates the proven host sequence for making `adapter.*` execution
 * subjects locally owned, so every adapter-capable runtime composes it the
 * same way instead of reinventing it. There are two phases because the kernel
 * lifecycle requires it:
 *
 * 1. {@link prepareAdapterRuntime} — call **before** `coordinator.startAll()`:
 *    builds the adapter-subsystem package (add it to the coordinator load set)
 *    and registers the adapter contribution processor so adapter contributions
 *    are awaited during activation.
 * 2. {@link activateAdapterRuntimeIdentity} — call **after** `coordinator.startAll()`:
 *    registers the adapter-runtime identity handlers and the adapter-name
 *    resolver, which resolve `adapterName` to the deterministic adapter id that
 *    live `AIAdapter` instances filter `AdapterSubjects.startAgent` on.
 *
 * The locality invariant this seam upholds: the `currentMachineId` passed to
 * {@link activateAdapterRuntimeIdentity} MUST be the same machine id the
 * coordinator injects as `extensionContextBase.machineId` (and therefore the
 * id `AdapterSubsystemService` and `SubagentService` derive adapter ids from).
 * If they diverge, `AdapterRuntimeSubjects.resolveId` yields an id no local
 * adapter listens on and `startAgent` silently falls through to the transport.
 */

/** Input for {@link prepareAdapterRuntime} (the pre-`startAll` phase). */
export interface PrepareAdapterRuntimeInput {
  /** Coordinator that loads the adapter-subsystem package and owns activation. */
  readonly coordinator: ExtensionCoordinator;
  /** Persistence seam for adapter/provider configuration. */
  readonly configRepository: IAdapterConfigRepository;
  /** Platform defaults (cwd/env) supplied to adapter instances. */
  readonly platformDefaults: PlatformDefaults;
  /** Trusted non-serializable auth preparer forwarded to every loaded adapter. */
  readonly prepareAuthRuntime?: unknown;
}

/** Result of {@link prepareAdapterRuntime}. */
export interface PreparedAdapterRuntime {
  /**
   * The adapter-subsystem package. The caller MUST add this to the array passed
   * to `coordinator.load(...)`; its `create` reads `ctx.machineId`, so adapter
   * ids derive from the coordinator's machine id.
   */
  readonly adapterSubsystemPackage: ReturnType<typeof createAdapterSubsystemPackage>;
}

/** Input for {@link activateAdapterRuntimeIdentity} (the post-`startAll` phase). */
export interface ActivateAdapterRuntimeIdentityInput {
  /** Bus the identity handlers and name resolver are registered on. */
  readonly bus: IMakaioBus;
  /**
   * The runtime's machine id. MUST equal the coordinator's
   * `extensionContextBase.machineId` (see the locality invariant above).
   */
  readonly currentMachineId: string;
  /**
   * Optional override for enumerating known adapter names. Defaults to querying
   * `AdapterSubsystemSubjects.listAdapterConfigs` on the bus, matching the host.
   */
  readonly listKnownAdapterNames?: () => Promise<Iterable<string>>;
}

/** Result of {@link activateAdapterRuntimeIdentity}. */
export interface ActivatedAdapterRuntimeIdentity {
  /** Tear down the identity handlers and the adapter-name resolver. */
  readonly cleanup: () => void;
}

/**
 * Build the adapter-subsystem package and register its contribution processor.
 *
 * Call before `coordinator.startAll()`. Registering the contribution processor
 * only stores it for use during activation, so it is order-independent relative
 * to `coordinator.load(...)` as long as it happens before `startAll()`.
 * @param input - Coordinator, config repository, and platform defaults.
 * @returns The adapter-subsystem package to add to the coordinator load set.
 */
export function prepareAdapterRuntime(input: PrepareAdapterRuntimeInput): PreparedAdapterRuntime {
  const { coordinator, configRepository, platformDefaults, prepareAuthRuntime } = input;

  const adapterSubsystemPackage = createAdapterSubsystemPackage({
    configRepository,
    coordinator,
    platformDefaults,
    ...(prepareAuthRuntime !== undefined && { prepareAuthRuntime }),
  });

  coordinator.registerContributionProcessor(
    createAdapterSubsystemContributionProcessor({
      getAdapterSubsystemService: () => coordinator.getExtensionService(AdapterSubsystemToken),
    }),
  );

  return { adapterSubsystemPackage };
}

/**
 * Register the adapter-runtime identity handlers and adapter-name resolver.
 *
 * Call after `coordinator.startAll()` so that `CapabilityService` and the
 * adapter subsystem have registered their handlers.
 * @param input - Bus, the runtime machine id, and an optional name enumerator.
 * @returns A cleanup that tears both registrations down.
 */
export function activateAdapterRuntimeIdentity(
  input: ActivateAdapterRuntimeIdentityInput,
): ActivatedAdapterRuntimeIdentity {
  const { bus, currentMachineId } = input;

  const listKnownAdapterNames =
    input.listKnownAdapterNames ??
    (async (): Promise<Iterable<string>> => {
      const { configs } = await bus.request(AdapterSubsystemSubjects.listAdapterConfigs, {});
      return configs.map((config) => config.name);
    });

  const identity = registerAdapterRuntimeIdentityHandlers(bus, { currentMachineId, listKnownAdapterNames });
  const unregisterNameResolver = registerAdapterNameResolver(bus);

  return {
    cleanup: (): void => {
      identity.cleanup();
      unregisterNameResolver();
    },
  };
}
