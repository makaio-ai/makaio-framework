import type { IMakaioBus } from '@makaio/bus-core';
import { teardownWasObserved } from '@makaio/contracts';
import {
  initializeEnabledAdapters,
  type AdapterRetirementAttempt,
  type PlatformDefaults,
} from './adapter-runtime-lifecycle.js';
import { deferAdapterActivation, type DeferredAdapterActivation } from './adapter-runtime-deferred-activation.js';
import type { AdapterInstance, AdapterRuntimeEntry, LoadedAdapter } from './adapter-runtime-types.js';

/** Dependencies for admitting adapters into the runtime's existing lifecycle maps. */
export interface AdapterRuntimeAdmissionDependencies {
  /** Global bus passed through to adapter initialization. */
  readonly bus: IMakaioBus;
  /** Stable identifier of the machine hosting the adapter runtime. */
  readonly machineId: string;
  /** Resolves the session-ownership authority incarnation for each new adapter. */
  readonly resolveOwnerInstanceId: () => string;
  /** Loaded adapter definitions keyed by stable adapter name. */
  readonly loadedAdapters: Map<string, LoadedAdapter>;
  /** Managed runtime slots keyed by adapter ID. */
  readonly adapterEntries: Map<string, AdapterRuntimeEntry>;
  /** Deferred activation ownership keyed by exact loaded-definition identity. */
  readonly deferredActivations: Map<LoadedAdapter, DeferredAdapterActivation>;
  /** Resolves the stable runtime ID for a loaded adapter definition. */
  readonly resolveLoadedAdapterId: (adapter: LoadedAdapter) => string;
  /** Retires one runtime slot before replacement admission. */
  readonly retireAdapterEntry: (
    adapterId: string,
    adapterName: string,
    publishDeinitialization?: boolean,
  ) => Promise<AdapterRetirementAttempt | undefined>;
  /** Starts the registry's public initialization admission path. */
  readonly initializeAdapter: (adapter: LoadedAdapter, platformDefaults: PlatformDefaults) => Promise<void>;
}

/** Input for one adapter-runtime initialization admission attempt. */
export interface InitializeAdapterRuntimeOptions {
  /** Shared runtime maps and lifecycle callbacks. */
  readonly dependencies: AdapterRuntimeAdmissionDependencies;
  /** Loaded adapter definition to initialize. */
  readonly adapter: LoadedAdapter;
  /** Platform defaults forwarded to the adapter factory. */
  readonly platformDefaults: PlatformDefaults;
  /** Whether this call is owned by the deferred activation continuation. */
  readonly fromDeferredActivation: boolean;
}

/** Input for one adapter-runtime replacement admission attempt. */
export interface RestartAdapterRuntimeOptions {
  /** Shared runtime maps and lifecycle callbacks. */
  readonly dependencies: AdapterRuntimeAdmissionDependencies;
  /** Loaded adapter definition to replace. */
  readonly adapter: LoadedAdapter;
  /** Platform defaults forwarded to the adapter factory. */
  readonly platformDefaults: PlatformDefaults;
}

/**
 * Admit one adapter definition into an existing runtime lifecycle.
 *
 * The function owns no lifecycle state: every map and retirement operation is
 * supplied by the registry so the admission ordering remains coupled to the
 * registry's live, retiring, and deferred epochs.
 * @param options - Runtime maps, lifecycle callbacks, and one admission attempt.
 * @returns Promise that resolves once admission completes, joins, or defers.
 */
export async function initializeAdapterRuntime(options: InitializeAdapterRuntimeOptions): Promise<void> {
  const { dependencies, adapter, platformDefaults, fromDeferredActivation } = options;
  const {
    bus,
    machineId,
    resolveOwnerInstanceId,
    loadedAdapters,
    adapterEntries,
    deferredActivations,
    resolveLoadedAdapterId,
    retireAdapterEntry,
  } = dependencies;
  const deferred = deferredActivations.get(adapter);
  if (deferred !== undefined && !fromDeferredActivation) {
    await deferred.completion;
    return;
  }
  const adapterId = resolveLoadedAdapterId(adapter);
  const existing = adapterEntries.get(adapterId);
  if (existing?.state === 'live') return;
  if (existing?.state === 'retiring' && (await settleRetiringAdapterAdmission(options, adapterId, existing, deferred)))
    return;
  const initializedInstances = new Map<string, AdapterInstance>();
  await initializeEnabledAdapters(
    bus,
    machineId,
    [adapter],
    initializedInstances,
    platformDefaults,
    resolveOwnerInstanceId,
    (initializedAdapterId, ownerInstanceId) => {
      if (loadedAdapters.get(adapter.name) !== adapter) {
        throw new Error(`Adapter ${adapter.name} was stopped before initialization completed`);
      }
      const instance = initializedInstances.get(initializedAdapterId);
      if (instance === undefined) {
        throw new Error(`Initialized adapter ${initializedAdapterId} was not retained by its lifecycle`);
      }
      adapterEntries.set(initializedAdapterId, { state: 'live', instance, ownerInstanceId });
    },
    async (initializedAdapterId, adapterName, ownerInstanceId, instance, initializedPublicationBegan) => {
      if (initializedPublicationBegan) {
        adapterEntries.set(initializedAdapterId, { state: 'live', instance, ownerInstanceId });
      } else {
        adapterEntries.set(initializedAdapterId, {
          state: 'retiring',
          instance,
          ownerInstanceId,
          report: { evidence: 'unknown', detail: `Failed activation for ${adapterName} is retiring.` },
        });
      }
      await retireAdapterEntry(initializedAdapterId, adapterName, initializedPublicationBegan);
    },
    (candidate) =>
      loadedAdapters.get(candidate.name) === candidate && deferredActivations.get(candidate)?.cancelled !== true,
  );
}

/**
 * Join or establish the exact deferred activation required by a retiring slot.
 * @param options - Runtime maps, lifecycle callbacks, and one admission attempt.
 * @param adapterId - Stable runtime ID of the retiring adapter slot.
 * @param entry - Current retiring slot that blocks immediate initialization.
 * @param deferred - Existing deferred activation for this exact definition, if any.
 * @returns True when admission must stop after joining, deferring, or observing weak retirement evidence.
 */
async function settleRetiringAdapterAdmission(
  options: InitializeAdapterRuntimeOptions,
  adapterId: string,
  entry: Extract<AdapterRuntimeEntry, { state: 'retiring' }>,
  deferred: DeferredAdapterActivation | undefined,
): Promise<boolean> {
  const { dependencies, adapter, platformDefaults, fromDeferredActivation } = options;
  const { loadedAdapters, adapterEntries, deferredActivations, retireAdapterEntry } = dependencies;
  if (entry.flight === undefined) {
    const attempt = await retireAdapterEntry(adapterId, adapter.name);
    return attempt !== undefined && !teardownWasObserved(attempt.report.evidence);
  }
  if (fromDeferredActivation && deferred?.started) {
    deferred.started = false;
    deferred.retirementCompletion = entry.flight.completion;
    deferred.cancellationCompletion = entry.flight.cancellationCompletion;
    const report = await entry.flight.completion;
    if (deferred.cancelled || !teardownWasObserved(report.evidence)) return true;
    deferred.started = true;
    deferred.cancellationCompletion = deferred.completion;
    await initializeAdapterRuntime({ ...options, fromDeferredActivation: true });
    return true;
  }
  deferAdapterActivation(
    deferredActivations,
    entry.flight,
    adapter,
    platformDefaults,
    () => loadedAdapters.get(adapter.name) === adapter,
    () => adapterEntries.has(adapterId),
    (replacement, defaults) =>
      initializeAdapterRuntime({
        ...options,
        adapter: replacement,
        platformDefaults: defaults,
        fromDeferredActivation: true,
      }),
    (error) => console.error(`[AdapterRuntimeRegistry] Error activating deferred adapter "${adapter.name}":`, error),
  );
  return true;
}

/**
 * Retire an adapter before admitting its replacement when retirement evidence permits.
 * @param options - Runtime maps, lifecycle callbacks, and one replacement attempt.
 * @returns Promise that resolves once replacement admission completes, joins, or defers.
 */
export async function restartAdapterRuntime(options: RestartAdapterRuntimeOptions): Promise<void> {
  const { dependencies, adapter, platformDefaults } = options;
  const { deferredActivations, adapterEntries, resolveLoadedAdapterId, retireAdapterEntry } = dependencies;
  const deferred = deferredActivations.get(adapter);
  if (deferred !== undefined) {
    await deferred.completion;
    return;
  }
  const adapterId = resolveLoadedAdapterId(adapter);
  const attempt = await retireAdapterEntry(adapterId, adapter.name);
  if (attempt !== undefined && !teardownWasObserved(attempt.report.evidence)) {
    if (attempt.pendingCompletion !== undefined) {
      const runtimeEntry = adapterEntries.get(adapterId);
      const flight = runtimeEntry?.state === 'retiring' ? runtimeEntry.flight : undefined;
      deferAdapterActivation(
        deferredActivations,
        flight ?? { completion: attempt.pendingCompletion, cancellationCompletion: Promise.resolve() },
        adapter,
        platformDefaults,
        () => dependencies.loadedAdapters.get(adapter.name) === adapter,
        () => adapterEntries.has(adapterId),
        (replacement, defaults) =>
          initializeAdapterRuntime({
            dependencies,
            adapter: replacement,
            platformDefaults: defaults,
            fromDeferredActivation: true,
          }),
        (error) =>
          console.error(`[AdapterRuntimeRegistry] Error restarting deferred adapter "${adapter.name}":`, error),
      );
    }
    return;
  }
  await dependencies.initializeAdapter(adapter, platformDefaults);
}
