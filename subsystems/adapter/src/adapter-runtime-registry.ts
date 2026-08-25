import type { IMakaioBus } from '@makaio/bus-core';
import type { AvailableAdapter } from '@makaio/services-core/settings';
import { teardownWasObserved } from '@makaio/contracts';
import {
  retireAdapterInstance,
  resolveLoadedAdapterId,
  toAvailableAdapter,
  type AdapterRetirementAttempt,
  type PlatformDefaults,
} from './adapter-runtime-lifecycle.js';
import { AdapterSubsystemSubjects } from './namespace.js';
import {
  completeAdapterRetirementFlight,
  completeDeferredAdapterDeregistration,
  deinitializedAdapterIdentity,
  removeAdapterNameFromPackageTracking,
} from './adapter-runtime-deferred-cleanup.js';
import {
  deferAdapterActivationAfterActive,
  settleDeferredAdapterDeregistration,
  settleDeferredActivationsForShutdown,
  type DeferredAdapterActivation,
} from './adapter-runtime-deferred-activation.js';
import {
  initializeAdapterRuntime,
  restartAdapterRuntime,
  type AdapterRuntimeAdmissionDependencies,
} from './adapter-runtime-admission.js';
import type {
  AdapterInstance,
  AdapterRuntimeEntry,
  AdapterRuntimeRetirementFlight,
  LoadedAdapter,
} from './adapter-runtime-types.js';
import {
  aggregateAdapterInstanceTeardowns,
  type AdapterInstanceShutdownReport,
  type AdapterInstanceTeardownResult,
} from './adapter-instance-teardown.js';
import { startAdapterRetirementAttempt } from './adapter-runtime-deinitialization.js';

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
  /** Resolve the active session-ownership authority incarnation for each new adapter. */
  readonly resolveOwnerInstanceId?: () => string;
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
  private readonly resolveOwnerInstanceId: () => string;

  /**
   * All loaded adapter definitions, keyed by adapter name.
   *
   * Populated incrementally as adapter packages become `active`. Entries are
   * removed when the package is stopped.
   */
  private readonly loadedAdapters = new Map<string, LoadedAdapter>();

  /**
   * Managed adapter-runtime slots, keyed by `adapterId`.
   *
   * A slot is either live and dispatchable, or retiring after its routing was
   * withdrawn. Retiring handles are retained only until a later close attempt
   * proves they stopped or the host itself retires.
   */
  private readonly adapterEntries = new Map<string, AdapterRuntimeEntry>();

  /** Replacement activations coalesced by the exact loaded-definition epoch. */
  private readonly deferredActivations = new Map<LoadedAdapter, DeferredAdapterActivation>();

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
    this.resolveOwnerInstanceId =
      options.resolveOwnerInstanceId ??
      (() => {
        throw new Error('Adapter initialization requires a session ownership authority incarnation');
      });
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
    return new Map(
      [...this.adapterEntries].flatMap(([adapterId, entry]) =>
        entry.state === 'live' ? [[adapterId, entry.instance] as const] : [],
      ),
    );
  }

  /**
   * Check whether a live adapter instance exists for the loaded adapter.
   * @param adapter - Loaded adapter definition to inspect.
   * @returns True when the runtime has initialized this adapter.
   */
  public hasAdapterInstance(adapter: LoadedAdapter): boolean {
    return this.adapterEntries.get(this.resolveLoadedAdapterId(adapter))?.state === 'live';
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
   * Resolve a named adapter to its currently registered live instance ID.
   *
   * A loaded definition alone is not sufficient: disabled, deferred, failed,
   * stopped, and rollback-removed adapters have no entry in the live instance
   * map and therefore cannot be addressed by name.
   * @param adapterName - Adapter driver name.
   * @returns Registered live instance ID, or undefined when none is live.
   */
  public resolveLiveAdapterId(adapterName: string): string | undefined {
    const adapter = this.loadedAdapters.get(adapterName);
    if (!adapter) return undefined;

    const adapterId = this.resolveLoadedAdapterId(adapter);
    return this.adapterEntries.get(adapterId)?.state === 'live' ? adapterId : undefined;
  }

  /**
   * Return the current live identity for an instance ID, if it is still registered.
   * @param adapterId - Instance ID to verify against the current live registry.
   * @returns Exact identity, or `undefined` after deregistration or failed startup.
   */
  public resolveLiveAdapterIdentity(
    adapterId: string,
  ): { adapterId: string; adapterName: string; machineId: string; ownerInstanceId: string } | undefined {
    for (const adapter of this.loadedAdapters.values()) {
      const entry = this.adapterEntries.get(adapterId);
      if (this.resolveLoadedAdapterId(adapter) === adapterId && entry?.state === 'live') {
        return {
          adapterId,
          adapterName: adapter.name,
          machineId: this.machineId,
          ownerInstanceId: entry.ownerInstanceId,
        };
      }
    }
    return undefined;
  }

  /**
   * Snapshot the identities currently dispatchable on this runtime.
   * @returns Exact identities for every currently registered adapter instance.
   */
  public getLiveAdapterIdentities(): Array<{
    adapterId: string;
    adapterName: string;
    machineId: string;
    ownerInstanceId: string;
  }> {
    return [...this.adapterEntries.keys()].flatMap((adapterId) => {
      const identity = this.resolveLiveAdapterIdentity(adapterId);
      return identity === undefined ? [] : [identity];
    });
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
      const existingId = this.resolveLoadedAdapterId(existing);
      if (
        existing.packageName === packageName &&
        this.resolveLoadedAdapterId(loadedAdapter) === existingId &&
        this.adapterEntries.get(existingId)?.state === 'retiring'
      ) {
        this.loadedAdapters.set(loadedAdapter.name, loadedAdapter);
        const packageAdapterNames = this.packageAdapters.get(packageName) ?? [];
        if (!packageAdapterNames.includes(loadedAdapter.name)) {
          this.packageAdapters.set(packageName, [...packageAdapterNames, loadedAdapter.name]);
        }
        return;
      }
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
      // A pending close retains a stopped adapter definition until teardown is observed.
      // Do not turn that package's provider cleanup into a replacement activation.
      if (adapter.packageName === packageName) continue;
      const providers = adapter.providers.filter((provider) => provider.providerPackageName !== packageName);
      if (providers.length === adapter.providers.length) continue;
      const updated = { ...adapter, providers };
      this.loadedAdapters.set(adapter.name, updated);
      updatedAdapters.push(updated);
      const runtimeEntry = this.adapterEntries.get(this.resolveLoadedAdapterId(updated));
      if (
        runtimeEntry === undefined &&
        deferAdapterActivationAfterActive(
          this.deferredActivations,
          updated,
          platformDefaults,
          () => this.loadedAdapters.get(updated.name) === updated,
          (replacement, defaults) => this.initializeAdapterInternal(replacement, defaults, true),
          (error) =>
            console.error(
              `[AdapterRuntimeRegistry] Error activating deferred adapter "${updated.name}" after provider package "${packageName}" stopped:`,
              error,
            ),
        )
      ) {
        continue;
      }
      if (runtimeEntry?.state === 'live' || runtimeEntry?.flight !== undefined) {
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
   * Retire the managed instance (if any) for a named adapter.
   *
   * Every attempt immediately removes the instance from routing. Only observed
   * teardown evidence releases its slot; weak evidence retains a non-routable
   * handle for a later retry.
   * @param adapterName - Adapter driver name to deregister.
   */
  public async deregisterAdapter(adapterName: string): Promise<void> {
    const adapter = this.loadedAdapters.get(adapterName);
    if (!adapter) return;

    const adapterId = this.resolveLoadedAdapterId(adapter);
    const deferredSettled = await settleDeferredAdapterDeregistration(
      this.deferredActivations,
      adapter,
      () => this.loadedAdapters.get(adapterName) === adapter,
      () => this.adapterEntries.get(adapterId),
      () => {
        this.loadedAdapters.delete(adapterName);
        removeAdapterNameFromPackageTracking(this.packageAdapters, adapter.packageName, adapterName);
      },
    );
    if (deferredSettled) return;
    const attempt = await this.retireAdapterEntry(adapterId, adapter.name);
    if (attempt === undefined || teardownWasObserved(attempt.report.evidence)) this.loadedAdapters.delete(adapterName);
    else if (attempt.pendingCompletion !== undefined) {
      void attempt.pendingCompletion.then((lateReport) => {
        if (teardownWasObserved(lateReport.evidence)) {
          completeDeferredAdapterDeregistration(
            this.loadedAdapters,
            this.adapterEntries,
            this.packageAdapters,
            adapterName,
            adapter,
            adapterId,
          );
        }
      });
    }
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
    const adapterNames = this.packageAdapters.get(packageName);
    if (
      adapterNames?.some((adapterName) => {
        const adapter = this.loadedAdapters.get(adapterName);
        return (
          adapter !== undefined && this.adapterEntries.get(this.resolveLoadedAdapterId(adapter))?.state === 'retiring'
        );
      })
    ) {
      return;
    }
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
        const adapter = this.loadedAdapters.get(adapterName);
        if (
          adapter !== undefined &&
          this.adapterEntries.get(this.resolveLoadedAdapterId(adapter))?.state === 'retiring'
        ) {
          failed = true;
        }
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
    const initialized = this.adapterEntries.get(adapterId)?.state === 'live';

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
    await this.initializeAdapterInternal(adapter, platformDefaults, false);
  }

  /**
   * Initialize one adapter, optionally from the deferred activation that owns its flight.
   * @param adapter - Loaded adapter definition to initialize.
   * @param platformDefaults - Platform-provided defaults forwarded to the factory.
   * @param fromDeferredActivation - True only for this registry's deferred continuation.
   */
  private async initializeAdapterInternal(
    adapter: LoadedAdapter,
    platformDefaults: PlatformDefaults,
    fromDeferredActivation: boolean,
  ): Promise<void> {
    await initializeAdapterRuntime({
      dependencies: this.createAdmissionDependencies(),
      adapter,
      platformDefaults,
      fromDeferredActivation,
    });
  }

  /**
   * Recreate an enabled adapter instance from the current loaded definition.
   *
   * Used when provider definitions change while the adapter package remains
   * active. A replacement is admitted only after the prior handle has proved
   * it stopped; weak evidence leaves that handle retiring for a later retry.
   * @param adapter - Loaded adapter definition to instantiate.
   * @param platformDefaults - Platform-provided defaults forwarded to the factory.
   */
  public async restartAdapterInstance(adapter: LoadedAdapter, platformDefaults: PlatformDefaults): Promise<void> {
    await restartAdapterRuntime({ dependencies: this.createAdmissionDependencies(), adapter, platformDefaults });
  }

  /**
   * Bind the registry-owned maps and retirement operation for runtime admission.
   * @returns Dependencies shared by initialization and replacement admission.
   */
  private createAdmissionDependencies(): AdapterRuntimeAdmissionDependencies {
    return {
      bus: this.bus,
      machineId: this.machineId,
      resolveOwnerInstanceId: this.resolveOwnerInstanceId,
      loadedAdapters: this.loadedAdapters,
      adapterEntries: this.adapterEntries,
      deferredActivations: this.deferredActivations,
      resolveLoadedAdapterId: (adapter) => this.resolveLoadedAdapterId(adapter),
      retireAdapterEntry: (adapterId, adapterName, publishDeinitialization) =>
        this.retireAdapterEntry(adapterId, adapterName, publishDeinitialization),
      initializeAdapter: (adapter, platformDefaults) => this.initializeAdapter(adapter, platformDefaults),
    };
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  /**
   * Shut down all live adapter instances and clear all in-memory tracking maps.
   *
   * Intended to be called from the owning service's `onDestroy` hook. The report
   * is returned rather than discarded: an instance whose close did not land is the
   * one fact a shutdown can produce that somebody above may need, and swallowing it
   * here would make reporting it below pointless.
   * @returns Per-instance teardown results and the class standing for all of them.
   */
  public async shutdownAll(): Promise<AdapterInstanceShutdownReport> {
    await settleDeferredActivationsForShutdown(this.deferredActivations);
    const results = await Promise.all(
      [...this.adapterEntries.keys()].map(async (adapterId) => {
        const adapterName = [...this.loadedAdapters.values()].find(
          (candidate) => this.resolveLoadedAdapterId(candidate) === adapterId,
        )?.name;
        if (adapterName === undefined) throw new Error(`Managed adapter ${adapterId} has no loaded definition`);
        const attempt = await this.retireAdapterEntry(adapterId, adapterName);
        return attempt === undefined ? { adapterId, evidence: 'released' as const } : attempt.report;
      }),
    );
    const report = aggregateAdapterInstanceTeardowns(results);
    this.loadedAdapters.clear();
    this.packageAdapters.clear();
    this.adapterEntries.clear();
    return report;
  }

  /**
   * Retire one adapter slot without admitting a replacement over weak evidence.
   * @param adapterId - Runtime identifier of the adapter to retire.
   * @param adapterName - Stable adapter implementation name for withdrawal.
   * @param publishDeinitialization - Whether a previous initialized publication may need withdrawal.
   * @returns The retirement result, or `undefined` when no slot was managed.
   */
  private async retireAdapterEntry(
    adapterId: string,
    adapterName: string,
    publishDeinitialization = true,
  ): Promise<AdapterRetirementAttempt | undefined> {
    const entry = this.adapterEntries.get(adapterId);
    if (entry === undefined) return undefined;

    if (entry.state === 'retiring' && entry.flight !== undefined) {
      return { report: { adapterId, ...entry.report }, pendingCompletion: entry.flight.completion };
    }

    const report =
      entry.state === 'retiring'
        ? entry.report
        : { evidence: 'unknown' as const, detail: 'Adapter retirement is in progress.' };
    const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<AdapterInstanceTeardownResult>();
    const { promise: cancellationCompletion, resolve: resolveCancellationCompletion } = Promise.withResolvers<void>();
    const flight: AdapterRuntimeRetirementFlight = { completion, cancellationCompletion };
    this.adapterEntries.set(adapterId, {
      state: 'retiring',
      instance: entry.instance,
      ownerInstanceId: entry.ownerInstanceId,
      report,
      flight,
    });
    const attempt = await startAdapterRetirementAttempt(
      this.bus,
      deinitializedAdapterIdentity(this.adapterEntries, this.machineId, adapterId, adapterName),
      () => retireAdapterInstance(adapterId, entry.instance),
      entry.state === 'live' && publishDeinitialization,
    );
    resolveCancellationCompletion();
    if (attempt.pendingCompletion !== undefined) {
      this.adapterEntries.set(adapterId, {
        state: 'retiring',
        instance: entry.instance,
        ownerInstanceId: entry.ownerInstanceId,
        report: attempt.report,
        flight,
      });
      void attempt.pendingCompletion.then(
        (lateReport) => {
          completeAdapterRetirementFlight(this.adapterEntries, adapterId, entry.instance, flight, lateReport);
          resolveCompletion(lateReport);
        },
        () => {
          completeAdapterRetirementFlight(this.adapterEntries, adapterId, entry.instance, flight, attempt.report);
          resolveCompletion(attempt.report);
        },
      );
      return { report: attempt.report, pendingCompletion: flight.completion };
    }
    completeAdapterRetirementFlight(this.adapterEntries, adapterId, entry.instance, flight, attempt.report);
    resolveCompletion(attempt.report);
    return attempt;
  }
}
