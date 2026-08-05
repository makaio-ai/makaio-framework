import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import type { AdapterContribution, ProtocolId, ProviderAIModel } from '@makaio/contracts';
import type { ProtocolRef } from '@makaio/contracts/extension';
import { ExtensionSubjects } from '@makaio/kernel';
import type { ExtensionCoordinator } from '@makaio/kernel';
import type { ContributionProcessor, KernelExtensionContext, KernelMakaioExtension } from '@makaio/kernel/extension';
import { buildDeterministicAdapterId } from '@makaio/services-core/adapter-runtime';
import type { AdapterConfigStore } from './adapter-config-store.js';
import type { AdapterRuntimeRegistry } from './adapter-runtime-registry.js';
import type { PlatformDefaults } from './adapter-runtime-lifecycle.js';
import type { LoadedAdapter } from './adapter-runtime-types.js';
import { contributesToAdapterSubsystem } from './adapter-subsystem-contribution-factory.js';
import {
  cloneAdapterClientRefs,
  resolveAdapterClientDefinitions,
  resolveDefaultClientId,
  validateAdapterClientRefs,
  type AdapterClientCatalogEntry,
} from './adapter-client-refs.js';
import {
  populateProviderModels,
  resolveLoadedAdapterProviders,
  resolveProviderDefinitions,
  type ProviderDefinitionCacheEntry,
} from './adapter-provider-resolution.js';

/**
 * Extract protocol IDs from a manifest protocol declaration.
 * @param protocols - Manifest protocol refs to normalize.
 * @returns Unique protocol IDs declared by the manifest.
 */
function extractManifestProtocolIds(protocols: readonly ProtocolRef[]): ProtocolId[] {
  const protocolIds = new Set<ProtocolId>();

  for (const protocol of protocols) {
    if (typeof protocol === 'string') {
      if (protocol === 'anthropic' || protocol === 'openai') {
        protocolIds.add(protocol);
      }
      continue;
    }

    if (protocol.anthropic !== undefined) protocolIds.add('anthropic');
    if (protocol.openai !== undefined) protocolIds.add('openai');
  }

  return [...protocolIds];
}

/**
 * Resolve the active runtime protocol from definition and manifest metadata.
 * @param adapterName - Adapter name used for invariant error messages.
 * @param definitionProtocol - Runtime-active protocol declared by the adapter definition.
 * @param manifestProtocols - Discovery protocols declared by the adapter manifest.
 * @returns Active runtime protocol, or undefined when a multi-protocol manifest does not choose one.
 */
function resolveRuntimeProtocol(
  adapterName: string,
  definitionProtocol: ProtocolId | undefined,
  manifestProtocols: readonly ProtocolRef[],
): ProtocolId | undefined {
  const manifestProtocolIds = extractManifestProtocolIds(manifestProtocols);

  if (definitionProtocol !== undefined) {
    if (!manifestProtocolIds.includes(definitionProtocol)) {
      throw new Error(
        `Adapter "${adapterName}" definition protocol "${definitionProtocol}" must be declared in ` +
          `manifest.protocols [${manifestProtocolIds.join(', ')}].`,
      );
    }
    return definitionProtocol;
  }

  return manifestProtocolIds.length === 1 ? manifestProtocolIds[0] : undefined;
}

/**
 * Constructor options for {@link AdapterContributionProcessor}.
 */
export interface AdapterContributionProcessorOptions {
  /**
   * Store used for file-backed adapter config reads and writes.
   */
  readonly configStore: AdapterConfigStore;
  /**
   * Registry that owns loaded-adapter definitions and live instances.
   */
  readonly registry: AdapterRuntimeRegistry;
  /**
   * Extension coordinator with which the contribution processor is registered.
   */
  readonly coordinator: ExtensionCoordinator;
  /**
   * Stable machine identifier used for deterministic adapter ID derivation.
   */
  readonly machineId: string;
  /**
   * Platform-provided defaults forwarded to adapter factories.
   */
  readonly platformDefaults: PlatformDefaults;
  /** Trusted host-layer auth preparer forwarded opaquely to adapter factories. */
  readonly prepareAuthRuntime?: unknown;
}

/**
 * Handles the full activation and deactivation lifecycle for adapter
 * contributions declared by extension packages.
 *
 * Registers a {@link ContributionProcessor} with the {@link ExtensionCoordinator}
 * so that adapter initialization is awaited before the coordinator advances to
 * subsequent boot phases, preventing races between adapter setup and later boot
 * phases.
 *
 * **Error semantics (Q2):** Hard failures during activation throw. If the Nth
 * adapter in a package fails, every adapter registered so far, including the
 * current adapter when failure happens after registration, is rolled back in
 * reverse order before re-throwing. The coordinator catches the error and
 * transitions the extension to `failed`.
 */
export class AdapterContributionProcessor {
  private readonly configStore: AdapterConfigStore;
  private readonly registry: AdapterRuntimeRegistry;
  private readonly coordinator: ExtensionCoordinator;
  private readonly machineId: string;
  private readonly platformDefaults: PlatformDefaults;
  private readonly prepareAuthRuntime: unknown;

  /**
   * Create a new adapter contribution processor.
   * @param options - Dependencies and configuration for the processor.
   */
  public constructor(options: AdapterContributionProcessorOptions) {
    this.configStore = options.configStore;
    this.registry = options.registry;
    this.coordinator = options.coordinator;
    this.machineId = options.machineId;
    this.platformDefaults = options.platformDefaults;
    this.prepareAuthRuntime = options.prepareAuthRuntime;
  }

  /**
   * Create a {@link ContributionProcessor} and register it with the coordinator.
   *
   * The cleanup function returned by `registerContributionProcessor` is passed
   * to `addCleanup` so the owning service can unregister the processor during
   * teardown.
   * @param addCleanup - Callback that registers a teardown function with the owning lifecycle.
   */
  public register(addCleanup: (fn: () => void) => void): void {
    const processor: ContributionProcessor = {
      filter: contributesToAdapterSubsystem,
      processActivated: async (
        name: string,
        pkg: KernelMakaioExtension,
        ctx: KernelExtensionContext,
      ): Promise<void> => {
        await this.onPackageActivated(name, pkg, ctx);
      },
      processStopped: async (name: string): Promise<void> => {
        await this.onPackageStopped(name);
      },
    };
    addCleanup(this.coordinator.registerContributionProcessor(processor));
  }

  /**
   * Process all adapters declared by a package that just became `active`.
   *
   * Processes each contribution sequentially to maintain the publication chain
   * serialization invariant.
   *
   * **Error semantics (Q2):** Hard failures throw. If the Nth adapter fails,
   * every adapter registered so far is rolled back in reverse order using
   * {@link AdapterRuntimeRegistry.deregisterAdapter} before re-throwing. The
   * coordinator catches the error and transitions the extension to `failed`.
   *
   * `adapter.registered` events are published only after all contributions in
   * the package have activated successfully, so rollback cannot leave
   * observers with a false live-registration event.
   * @param packageName - Name of the package that transitioned to `active`.
   * @param pkg - Extension manifest with `adapters` contributions.
   * @param ctx - Per-extension context containing the boot bus.
   */
  public async onPackageActivated(
    packageName: string,
    pkg: KernelMakaioExtension,
    ctx: KernelExtensionContext,
  ): Promise<void> {
    const contributions = pkg.adapters ?? [];
    const activated: string[] = [];
    const completed: LoadedAdapter[] = [];
    const providerModelCache = new Map<string, ProviderAIModel[]>();

    const catalog = await ctx.bus.request(ExtensionSubjects.contributions.catalog, {});
    const providerDefinitionCache = new Map<string, ProviderDefinitionCacheEntry>();
    for (const entry of catalog.providers) {
      providerDefinitionCache.set(entry.definition.id, entry);
    }
    for (const definition of pkg.providers ?? []) {
      providerDefinitionCache.set(definition.id, { packageName, definition });
    }
    const clientCatalog = catalog.clients as readonly AdapterClientCatalogEntry[];
    const loadedProviderIds = this.coordinator.getLoadedProviderDefinitionIds();

    try {
      for (const contribution of contributions) {
        const loadedAdapter = await this.activateAdapterContribution(
          packageName,
          contribution,
          ctx.bus,
          providerModelCache,
          providerDefinitionCache,
          clientCatalog,
          loadedProviderIds,
        );
        activated.push(contribution.definition.name);
        completed.push(loadedAdapter);
      }
    } catch (err) {
      let rollbackFailed = false;
      for (const adapterName of activated.reverse()) {
        try {
          await this.registry.deregisterAdapter(adapterName);
        } catch (rollbackErr) {
          rollbackFailed = true;
          console.error(`[AdapterContributionProcessor] Rollback error for adapter "${adapterName}":`, rollbackErr);
        }
      }
      if (!rollbackFailed) {
        this.registry.removePackageTracking(packageName);
      }
      throw err;
    }

    await this.publishActivatedAdapters(completed);
    const initializedWaitingAdapters = await this.initializeAdaptersWaitingForProviders(
      ctx.bus,
      providerModelCache,
      providerDefinitionCache,
      loadedProviderIds,
    );
    await this.publishActivatedAdapters(initializedWaitingAdapters);
  }

  /**
   * Process a single adapter contribution from an active package.
   *
   * Steps:
   * 1. Build a `LoadedAdapter` from the manifest and definition
   * 2. Ensure the file-backed config exists
   * 3. Register in the in-memory registry and update package tracking
   * 4. Initialize the instance when enabled
   * 5. Publish `adapter.registered` through the serialized publication chain
   * @param packageName - Owning package name.
   * @param contribution - Adapter contribution from the package manifest.
   * @param bus - Bus used to resolve registry-populated provider models.
   */
  public async processAdapterContribution(
    packageName: string,
    contribution: AdapterContribution,
    bus: IMakaioBus = MakaioBus,
  ): Promise<void> {
    const loadedProviderIds = this.coordinator.getLoadedProviderDefinitionIds();
    const loadedAdapter = await this.activateAdapterContribution(
      packageName,
      contribution,
      bus,
      new Map<string, ProviderAIModel[]>(),
      undefined,
      undefined,
      loadedProviderIds,
    );
    await this.publishActivatedAdapters([loadedAdapter]);
  }

  /**
   * Register and initialize one adapter contribution without publishing its
   * `adapter.registered` event.
   *
   * Publication is intentionally deferred until the package has fully
   * activated. If registration succeeds and a later step fails, this method
   * deregisters the current adapter before re-throwing.
   * @param packageName - Owning package name.
   * @param contribution - Adapter contribution from the package manifest.
   * @param bus - Bus used to resolve registry-populated provider models.
   * @param providerModelCache - Per-batch cache deduplicating provider model bus calls.
   * @param providerDefinitionCache - Pre-built provider definition map from the batch caller.
   * @param clientCatalog - Pre-built active client catalog from the batch caller.
   * @param loadedProviderIds - Universe of active or activation-eligible provider definition IDs.
   * @returns Loaded adapter after successful registration and optional initialization.
   */
  private async activateAdapterContribution(
    packageName: string,
    contribution: AdapterContribution,
    bus: IMakaioBus,
    providerModelCache: Map<string, ProviderAIModel[]>,
    providerDefinitionCache: Map<string, ProviderDefinitionCacheEntry> | undefined,
    clientCatalog: readonly AdapterClientCatalogEntry[] | undefined,
    loadedProviderIds: ReadonlySet<string>,
  ): Promise<LoadedAdapter> {
    const loadedAdapter = await this.buildLoadedAdapter(
      packageName,
      contribution,
      bus,
      providerModelCache,
      providerDefinitionCache,
      clientCatalog,
    );
    let registered = false;

    try {
      await this.ensureAdapterConfig(loadedAdapter);
      const enabled = this.configStore.isAdapterEnabled(loadedAdapter.name);
      if (enabled) {
        await this.validateEnabledAdapterClientRefs(loadedAdapter, bus, clientCatalog);
      }

      this.registry.registerAdapter(loadedAdapter, packageName);
      registered = true;

      if (enabled) {
        if (this.getMissingProviderDefinitionIds(loadedAdapter, loadedProviderIds).length > 0) {
          console.info(
            `[AdapterContributionProcessor] Deferring adapter "${loadedAdapter.name}" initialization until declared providers are active.`,
          );
        } else {
          await this.registry.initializeAdapter(loadedAdapter, this.platformDefaults);
          console.info(
            `[AdapterContributionProcessor] Initialized adapter: ${loadedAdapter.name} (${loadedAdapter.packageName})`,
          );
        }
      }
    } catch (err) {
      if (registered) {
        try {
          await this.registry.deregisterAdapter(loadedAdapter.name);
        } catch (rollbackErr) {
          console.error(
            `[AdapterContributionProcessor] Rollback error for adapter "${loadedAdapter.name}":`,
            rollbackErr,
          );
        }
      }
      throw err;
    }

    return loadedAdapter;
  }

  /**
   * Initialize enabled adapters that were registered before all declared providers were active.
   * @param bus - Bus used to resolve the current extension contribution catalog.
   * @param providerModelCache - Per-batch provider model cache.
   * @param providerDefinitionCache - Per-batch provider definition cache, including the currently activating package.
   * @param loadedProviderIds - Universe of active or activation-eligible provider definition IDs.
   * @returns Adapters initialized by this retry pass.
   */
  private async initializeAdaptersWaitingForProviders(
    bus: IMakaioBus,
    providerModelCache: Map<string, ProviderAIModel[]>,
    providerDefinitionCache: Map<string, ProviderDefinitionCacheEntry>,
    loadedProviderIds: ReadonlySet<string>,
  ): Promise<LoadedAdapter[]> {
    const initialized: LoadedAdapter[] = [];
    for (const adapter of this.registry.getLoadedAdapters()) {
      let refreshedForPublication: LoadedAdapter | undefined;
      try {
        if (!this.configStore.isAdapterEnabled(adapter.name)) continue;

        let refreshed = adapter;
        if (this.getMissingProviderDefinitionIds(adapter, loadedProviderIds).length > 0) {
          const providers = await resolveLoadedAdapterProviders(
            adapter,
            bus,
            providerModelCache,
            providerDefinitionCache,
          );
          const updated = this.registry.updateAdapterProviders(adapter.name, providers);
          if (!updated || this.getMissingProviderDefinitionIds(updated, loadedProviderIds).length > 0) continue;
          refreshed = updated;
          refreshedForPublication = updated;
        }

        if (this.registry.hasAdapterInstance(refreshed)) {
          if (refreshed === adapter) continue;
          await this.registry.restartAdapterInstance(refreshed, this.platformDefaults);
        } else {
          await this.registry.initializeAdapter(refreshed, this.platformDefaults);
        }
        console.info(
          `[AdapterContributionProcessor] Initialized adapter: ${refreshed.name} (${refreshed.packageName}) after provider activation`,
        );
        initialized.push(refreshed);
      } catch (error) {
        console.error(
          `[AdapterContributionProcessor] Deferred initialization failed for adapter "${adapter.name}".`,
          error,
        );
        if (refreshedForPublication) {
          initialized.push(refreshedForPublication);
        }
      }
    }
    return initialized;
  }

  /**
   * Return provider definition IDs that have not resolved on a loaded adapter
   * and whose provider extension is active or still eligible to activate.
   *
   * Provider IDs absent from {@link loadedProviderIds} correspond to extensions
   * that are not installed or cannot still become active, including disabled,
   * skipped, stopped, or failed packages. Those IDs are excluded so
   * optional-provider adapters do not defer initialization indefinitely waiting
   * for providers the catalog cannot resolve.
   * @param adapter - Loaded adapter to inspect.
   * @param loadedProviderIds - Universe of active or activation-eligible provider definition IDs.
   * @returns Missing provider definition IDs that may still resolve.
   */
  private getMissingProviderDefinitionIds(adapter: LoadedAdapter, loadedProviderIds: ReadonlySet<string>): string[] {
    const resolved = new Set(adapter.providers.map((provider) => provider.definition.id));
    return adapter.providerDefinitionIds.filter((id) => !resolved.has(id) && loadedProviderIds.has(id));
  }

  /**
   * Validate runtime binary compatibility for an enabled adapter.
   *
   * Static client definition compatibility is checked while building the loaded
   * adapter. Concrete binary resolution is deferred until the adapter is enabled
   * so a disabled package can register without requiring the user's CLI binary
   * to be installed at boot.
   * @param loadedAdapter - Adapter whose enabled runtime dependencies are being checked.
   * @param bus - Bus used to resolve binary context and, when needed, the active client catalog.
   * @param clientCatalog - Optional client catalog snapshot already loaded by the activation batch.
   */
  private async validateEnabledAdapterClientRefs(
    loadedAdapter: LoadedAdapter,
    bus: IMakaioBus,
    clientCatalog?: readonly AdapterClientCatalogEntry[],
  ): Promise<void> {
    if (loadedAdapter.clients === undefined || loadedAdapter.clients.length === 0) return;
    const resolvedClientCatalog =
      clientCatalog ?? (await bus.request(ExtensionSubjects.contributions.catalog, {})).clients;
    await validateAdapterClientRefs(loadedAdapter.name, loadedAdapter.clients, resolvedClientCatalog, bus);
  }

  /**
   * Build a `LoadedAdapter` from an `AdapterContribution` declared by a package.
   *
   * Maps the typed `AdapterDefinitionContract` on the contribution to the
   * runtime `LoadedAdapter` shape used by the adapter subsystem internals.
   *
   * When `providerModelCache` is supplied, the result of each
   * `getProviderModels` bus request is cached by provider ID so that the same
   * provider queried by multiple adapters in the same boot batch only triggers
   * one RPC call.
   * @param packageName - Package that declared this contribution.
   * @param contribution - Adapter manifest and definition pair.
   * @param bus - Bus used to resolve provider model catalogs from the model registry.
   * @param providerModelCache - Optional per-batch cache deduplicating provider model bus calls.
   * @param providerDefinitionCache - Optional per-batch cache deduplicating catalog bus calls.
   *   When supplied, the catalog RPC is skipped and provider definitions are resolved from this map.
   * @param clientCatalog - Optional active client catalog used to validate adapter client refs.
   * @returns Constructed loaded adapter ready for registration.
   */
  public async buildLoadedAdapter(
    packageName: string,
    contribution: AdapterContribution,
    bus: IMakaioBus = MakaioBus,
    providerModelCache: Map<string, ProviderAIModel[]> = new Map(),
    providerDefinitionCache?: Map<string, ProviderDefinitionCacheEntry>,
    clientCatalog?: readonly AdapterClientCatalogEntry[],
  ): Promise<LoadedAdapter> {
    const def = contribution.definition;
    const manifest = contribution.manifest;
    const adapterName = def.name;
    const resolvedClientCatalog =
      clientCatalog ?? (await bus.request(ExtensionSubjects.contributions.catalog, {})).clients;
    await validateAdapterClientRefs(adapterName, manifest.clients, resolvedClientCatalog, bus, {
      checkBinaryVersions: false,
    });
    const clientDefinitions = resolveAdapterClientDefinitions(manifest.clients, resolvedClientCatalog);
    const resolvedProviders = await resolveProviderDefinitions(bus, def.providers, adapterName, {
      ...(def.providerConfigSchema !== undefined && { adapterConfigSchema: def.providerConfigSchema }),
      ...(clientDefinitions !== undefined && { clientDefinitions }),
      ...(providerDefinitionCache !== undefined && { providerDefinitionCache }),
    });
    const providers = await populateProviderModels(bus, adapterName, resolvedProviders, providerModelCache);

    return {
      name: adapterName,
      displayName: def.displayName ?? manifest.displayName,
      description: def.description,
      packageName,
      factory: def.createAdapter as LoadedAdapter['factory'],
      options: {
        adapterId: buildDeterministicAdapterId(this.machineId, adapterName),
        ...(this.prepareAuthRuntime !== undefined && { prepareAuthRuntime: this.prepareAuthRuntime }),
      },
      adapterConfigSchema: def.adapterConfigSchema as LoadedAdapter['adapterConfigSchema'],
      providerDefinitionIds: def.providers.map((provider) => provider.definitionId),
      providerRefs: [...def.providers],
      providers: providers as LoadedAdapter['providers'],
      providerConfigSchema: def.providerConfigSchema,
      helpLinks: def.helpLinks as LoadedAdapter['helpLinks'],
      instructions: def.instructions,
      defaultPresetId: def.defaultPresetId,
      clients: cloneAdapterClientRefs(manifest.clients),
      ...(clientDefinitions !== undefined && { clientDefinitions }),
      protocol: resolveRuntimeProtocol(adapterName, def.protocol, manifest.protocols),
    };
  }

  /**
   * Ensure a file-backed adapter config exists for one loaded adapter.
   *
   * When no config file exists yet, creates one with `enabled: false` so that
   * newly discovered adapters are not silently activated on first boot.
   * @param adapter - Loaded adapter definition to register or update.
   */
  public async ensureAdapterConfig(adapter: LoadedAdapter): Promise<void> {
    const existing = this.configStore.getAdapterConfig(adapter.name);
    if (existing) return;

    await this.configStore.setAdapterConfig(adapter.name, {
      displayName: adapter.displayName,
      description: adapter.description,
      helpLinks: adapter.helpLinks?.map((link) => ({ ...link })),
      instructions: adapter.instructions,
      clientId: resolveDefaultClientId(adapter.options, adapter.clients),
      protocol: adapter.protocol,
      providerDefinitionIds: [...adapter.providerDefinitionIds],
      enabled: false,
    });
  }

  /**
   * Shut down all adapters contributed by a package that has stopped.
   *
   * Delegates to {@link AdapterRuntimeRegistry.deregisterPackage}.
   * Best-effort: errors are logged but never thrown — shutdown must not be
   * blocked.
   * @param packageName - Name of the package that transitioned to `stopped`.
   */
  public async onPackageStopped(packageName: string): Promise<void> {
    await this.registry.deregisterPackage(packageName);
    const updatedAdapters = await this.registry.removeProviderPackage(packageName, this.platformDefaults);
    await this.publishActivatedAdapters(updatedAdapters);
  }

  /**
   * Publish an `adapterSubsystem.adapter.registered` event through the
   * serialized publication chain to prevent concurrent dynamic-load races.
   * @param adapter - Loaded adapter to announce.
   * @returns Promise that resolves after the event has been emitted.
   */
  private publishAdapterRegistered(adapter: LoadedAdapter): Promise<void> {
    const enabled = this.configStore.isAdapterEnabled(adapter.name);
    const adapterId = this.registry.resolveLoadedAdapterId(adapter);

    return this.registry.publishAdapterRegistered({
      adapterName: adapter.name,
      displayName: adapter.displayName,
      packageName: adapter.packageName,
      enabled,
      adapterId,
      providerDefinitionIds: adapter.providerDefinitionIds,
    });
  }

  /**
   * Publish registration events for adapters that have fully activated.
   *
   * Registration events are observational and have no replay guarantee. Handler
   * failures are logged instead of rolling back already-live adapters, keeping
   * event failures from creating false live-registration notifications.
   * @param adapters - Activated adapters to announce.
   */
  private async publishActivatedAdapters(adapters: readonly LoadedAdapter[]): Promise<void> {
    for (const adapter of adapters) {
      try {
        await this.publishAdapterRegistered(adapter);
      } catch (err) {
        console.error(`[AdapterContributionProcessor] Failed to publish adapter "${adapter.name}" registration:`, err);
      }
    }
  }
}
