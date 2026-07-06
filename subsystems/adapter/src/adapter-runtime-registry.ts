import type { IMakaioBus } from '@makaio/bus-core';
import type { AvailableAdapter } from '@makaio/services-core/settings';
import {
  closeAdapterInstance,
  initializeEnabledAdapters,
  resolveLoadedAdapterId,
  shutdownAdapterInstances,
  toAvailableAdapter,
  type PlatformDefaults,
} from './adapter-runtime-lifecycle.js';
import { AdapterSubsystemSubjects } from './namespace.js';
import type { AdapterInstance, LoadedAdapter } from './adapter-runtime-types.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Constructor options for {@link AdapterRuntimeRegistry}.
 */
export interface AdapterRuntimeRegistryOptions {
  /** Bus instance used to emit `adapter.registered` events. */
  readonly bus: IMakaioBus;
  /** Stable machine identifier used for deterministic adapter ID derivation. */
  readonly machineId: string;
}

// ---------------------------------------------------------------------------
// Publication options
// ---------------------------------------------------------------------------

/**
 * Options for publishing an `adapter.registered` event.
 */
export interface PublishAdapterRegisteredOptions {
  /** Internal adapter driver name. */
  readonly adapterName: string;
  /** Human-readable display name for UI. */
  readonly displayName?: string;
  /** NPM package name the adapter was loaded from. */
  readonly packageName: string;
  /** Whether the adapter is enabled in file-backed settings. */
  readonly enabled: boolean;
  /** Deterministic adapter ID used to check for an existing live instance. */
  readonly adapterId: string;
  /** Provider definition IDs declared by this adapter. */
  readonly providerDefinitionIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Runtime adapter registry.
 *
 * Owns loaded adapter definitions, live adapter instances, package-to-adapter
 * tracking, and the serialized `adapter.registered` publication chain.
 *
 * This is a plain class — not a `BaseService`. Lifecycle (init / shutdown)
 * is delegated to the owning service.
 */
export class AdapterRuntimeRegistry {
  private readonly bus: IMakaioBus;
  private readonly machineId: string;

  /**
   * All loaded adapter definitions, keyed by adapter name.
   *
   * Populated incrementally as adapter packages become `active`. Entries are
   * removed when the package is stopped.
   */
  private readonly loadedAdapters = new Map<string, LoadedAdapter>();

  /**
   * Live adapter instances, keyed by `adapterId`.
   *
   * Only contains entries for adapters whose file-backed config has
   * `enabled: true`. Instances are shut down when the owning package stops.
   */
  private readonly adapterInstances = new Map<string, AdapterInstance>();

  /**
   * Maps each package name to the adapter names it contributed.
   *
   * Used to clean up the correct subset of entries when a package stops.
   */
  private readonly packageAdapters = new Map<string, string[]>();

  /**
   * Serialized publication chain for per-adapter `adapter.registered` events.
   *
   * Dynamic loads mutate shared in-memory maps, so publishing the live map
   * directly could give different callers a moving target. Serializing via a
   * promise chain keeps downstream registries in lockstep and prevents
   * concurrent dynamic-load race conditions.
   */
  private publicationChain = Promise.resolve();

  /**
   * Create a new adapter runtime registry.
   * @param options - Registry dependencies.
   */
  public constructor(options: AdapterRuntimeRegistryOptions) {
    this.bus = options.bus;
    this.machineId = options.machineId;
  }

  // ---------------------------------------------------------------------------
  // Public accessors
  // ---------------------------------------------------------------------------

  /**
   * Return the live loaded-adapter list.
   *
   * Callers must read at request time (lazy), not cache the result at
   * registration time, because adapters are loaded incrementally.
   * @returns Readonly array of all currently loaded adapter definitions.
   */
  public getLoadedAdapters(): readonly LoadedAdapter[] {
    return [...this.loadedAdapters.values()];
  }

  /**
   * Return the live adapter-instance map.
   *
   * Callers must read at request time (lazy), not cache the result at
   * registration time, because instances are created incrementally.
   * @returns Readonly map of adapter ID to live adapter instance.
   */
  public getAdapterInstances(): ReadonlyMap<string, AdapterInstance> {
    return this.adapterInstances;
  }

  /**
   * Check whether a live adapter instance exists for the loaded adapter.
   * @param adapter - Loaded adapter definition to inspect.
   * @returns True when the runtime has initialized this adapter.
   */
  public hasAdapterInstance(adapter: LoadedAdapter): boolean {
    return this.adapterInstances.has(this.resolveLoadedAdapterId(adapter));
  }

  /**
   * Resolve the runtime adapter ID for a loaded adapter.
   * @param adapter - Loaded adapter definition to inspect.
   * @returns Explicit adapter ID or deterministic runtime ID.
   */
  public resolveLoadedAdapterId(adapter: LoadedAdapter): string {
    return resolveLoadedAdapterId(adapter, this.machineId);
  }

  /**
   * Return settings-facing available-adapter list derived from loaded adapters.
   * @returns Readonly list of adapter metadata for the settings UI.
   */
  public getSettingsAvailableAdapters(): readonly AvailableAdapter[] {
    return [...this.loadedAdapters.values()].map(toAvailableAdapter);
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a loaded adapter definition and update package tracking.
   * @param loadedAdapter - Fully-constructed adapter definition to register.
   * @param packageName - NPM package name that contributed this adapter.
   * @throws If another package has already registered the same adapter name.
   */
  public registerAdapter(loadedAdapter: LoadedAdapter, packageName: string): void {
    const existing = this.loadedAdapters.get(loadedAdapter.name);
    if (existing) {
      throw new Error(
        `Duplicate adapter name '${loadedAdapter.name}' from owners '${existing.packageName}' and '${packageName}'.`,
      );
    }

    this.loadedAdapters.set(loadedAdapter.name, loadedAdapter);
    const packageAdapterNames = this.packageAdapters.get(packageName) ?? [];
    this.packageAdapters.set(packageName, [...packageAdapterNames, loadedAdapter.name]);
  }

  /**
   * Replace the provider definitions on a loaded adapter.
   * @param adapterName - Adapter driver name.
   * @param providers - Freshly resolved provider definitions.
   * @returns Updated loaded adapter, or undefined when the adapter is no longer registered.
   */
  public updateAdapterProviders(adapterName: string, providers: LoadedAdapter['providers']): LoadedAdapter | undefined {
    const adapter = this.loadedAdapters.get(adapterName);
    if (!adapter) return undefined;
    const updated = { ...adapter, providers };
    this.loadedAdapters.set(adapterName, updated);
    return updated;
  }

  /**
   * Remove provider definitions contributed by a stopped provider package from
   * all loaded adapters.
   * @param packageName - Provider package that stopped or was disabled.
   * @param platformDefaults - Platform-provided defaults forwarded to restarted adapter factories.
   * @returns Loaded adapters whose provider definitions changed.
   */
  public async removeProviderPackage(
    packageName: string,
    platformDefaults: PlatformDefaults,
  ): Promise<LoadedAdapter[]> {
    const updatedAdapters: LoadedAdapter[] = [];
    for (const adapter of this.loadedAdapters.values()) {
      const providers = adapter.providers.filter((provider) => provider.providerPackageName !== packageName);
      if (providers.length === adapter.providers.length) continue;
      const updated = { ...adapter, providers };
      this.loadedAdapters.set(adapter.name, updated);
      updatedAdapters.push(updated);
      if (this.hasAdapterInstance(updated)) {
        try {
          await this.restartAdapterInstance(updated, platformDefaults);
        } catch (error) {
          console.error(
            `[AdapterRuntimeRegistry] Error restarting adapter "${updated.name}" after provider package "${packageName}" stopped:`,
            error,
          );
        }
      }
    }
    return updatedAdapters;
  }

  /**
   * Shut down the live instance (if any) for a named adapter and remove it
   * from in-memory tracking only after shutdown succeeds.
   * @param adapterName - Adapter driver name to deregister.
   */
  public async deregisterAdapter(adapterName: string): Promise<void> {
    const adapter = this.loadedAdapters.get(adapterName);
    if (!adapter) return;

    const adapterId = this.resolveLoadedAdapterId(adapter);
    const instance = this.adapterInstances.get(adapterId);
    if (instance) {
      await closeAdapterInstance(adapterId, instance);
      this.adapterInstances.delete(adapterId);
    }
    this.loadedAdapters.delete(adapterName);
  }

  /**
   * Remove the package-to-adapter tracking entry without touching loaded
   * adapters or live instances.
   *
   * Used by the contribution processor during rollback: individual adapters
   * are deregistered via {@link deregisterAdapter} first, then this method
   * clears the package-level tracking that was partially built before the
   * failure.
   * @param packageName - Package name whose tracking entry should be removed.
   */
  public removePackageTracking(packageName: string): void {
    this.packageAdapters.delete(packageName);
  }

  /**
   * Deregister all adapters contributed by a stopped package.
   *
   * Best-effort: errors are logged but never thrown. Package tracking is
   * retained when any adapter close fails so a later stop can retry cleanup.
   * @param packageName - Name of the package that transitioned to `stopped`.
   */
  public async deregisterPackage(packageName: string): Promise<void> {
    const adapterNames = this.packageAdapters.get(packageName);
    if (!adapterNames?.length) return;

    let failed = false;
    for (const adapterName of adapterNames) {
      try {
        await this.deregisterAdapter(adapterName);
      } catch (err) {
        failed = true;
        console.error(`[AdapterRuntimeRegistry] Error shutting down adapter "${adapterName}":`, err);
      }
    }

    if (!failed) {
      this.packageAdapters.delete(packageName);
    }
  }

  // ---------------------------------------------------------------------------
  // Publication
  // ---------------------------------------------------------------------------

  /**
   * Publish an `adapterSubsystem.adapter.registered` event through the
   * serialized publication chain to prevent concurrent dynamic-load races.
   * @param options - Event payload fields and instance-presence hint.
   * @returns Promise that resolves after the event has been emitted.
   */
  public publishAdapterRegistered(options: PublishAdapterRegisteredOptions): Promise<void> {
    const { adapterName, displayName, packageName, enabled, adapterId, providerDefinitionIds } = options;
    const initialized = this.adapterInstances.has(adapterId);

    const publication = this.publicationChain
      .catch(() => undefined)
      .then(() =>
        this.bus.emit(AdapterSubsystemSubjects.adapter.registered, {
          adapterName,
          displayName: displayName ?? adapterName,
          packageName,
          enabled,
          initialized,
          providerDefinitionIds: [...providerDefinitionIds],
        }),
      );
    this.publicationChain = publication.catch(() => undefined);
    return publication;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize one adapter using its factory and the supplied platform defaults.
   *
   * Delegates to {@link initializeEnabledAdapters} which checks file-backed
   * enabled state before calling the factory.
   * @param adapter - Loaded adapter definition to initialize.
   * @param platformDefaults - Platform-provided defaults forwarded to the factory.
   */
  public async initializeAdapter(adapter: LoadedAdapter, platformDefaults: PlatformDefaults): Promise<void> {
    await initializeEnabledAdapters(this.bus, this.machineId, [adapter], this.adapterInstances, platformDefaults);
  }

  /**
   * Recreate an enabled live adapter instance from the current loaded
   * definition.
   *
   * Used when provider definitions change while the adapter package remains
   * active. The stale instance is removed before reinitialization so disabled
   * provider metadata cannot remain observable if the replacement fails.
   * @param adapter - Loaded adapter definition to instantiate.
   * @param platformDefaults - Platform-provided defaults forwarded to the factory.
   */
  public async restartAdapterInstance(adapter: LoadedAdapter, platformDefaults: PlatformDefaults): Promise<void> {
    const adapterId = this.resolveLoadedAdapterId(adapter);
    const instance = this.adapterInstances.get(adapterId);
    if (instance) {
      try {
        await closeAdapterInstance(adapterId, instance);
      } catch (error) {
        console.error(`[AdapterRuntimeRegistry] Error shutting down adapter "${adapter.name}" before restart:`, error);
        throw error;
      }
      this.adapterInstances.delete(adapterId);
    }
    await this.initializeAdapter(adapter, platformDefaults);
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Shut down all live adapter instances and clear all in-memory tracking maps.
   *
   * Intended to be called from the owning service's `onDestroy` hook.
   */
  public async shutdownAll(): Promise<void> {
    await shutdownAdapterInstances(this.adapterInstances);
    this.loadedAdapters.clear();
    this.packageAdapters.clear();
  }
}
