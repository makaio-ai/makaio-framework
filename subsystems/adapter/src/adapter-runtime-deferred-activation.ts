import { teardownWasObserved } from '@makaio/contracts';
import type { PlatformDefaults } from './adapter-runtime-lifecycle.js';
import type { AdapterRuntimeEntry, AdapterRuntimeRetirementFlight, LoadedAdapter } from './adapter-runtime-types.js';

/**
 * Defer one replacement activation until the exact retiring flight proves teardown.
 * @param deferredActivations - Per-definition activation promises used to coalesce callers.
 * @param flight - Exact retirement flight currently blocking activation.
 * @param adapter - Replacement definition whose object identity is its activation epoch.
 * @param platformDefaults - Defaults forwarded to a later factory invocation.
 * @param isCurrent - Confirms the same definition still owns its adapter name.
 * @param hasRuntimeEntry - Rejects stale continuation after any newer runtime slot appears.
 * @param initialize - Starts the normal registry initialization path.
 * @param onError - Reports a deferred activation failure without leaking a rejection.
 */
export function deferAdapterActivation(
  deferredActivations: Map<LoadedAdapter, DeferredAdapterActivation>,
  flight: AdapterRuntimeRetirementFlight,
  adapter: LoadedAdapter,
  platformDefaults: PlatformDefaults,
  isCurrent: () => boolean,
  hasRuntimeEntry: () => boolean,
  initialize: (adapter: LoadedAdapter, platformDefaults: PlatformDefaults) => Promise<void>,
  onError: (error: unknown) => void,
): void {
  // A timeout may let an older restart return after a newer definition has
  // already claimed this flight. Only the current epoch may transfer that claim.
  if (!isCurrent() || deferredActivations.has(adapter)) return;
  for (const [candidate, existing] of deferredActivations) {
    if (candidate.name === adapter.name && existing.retirementCompletion === flight.completion) {
      existing.cancelled = true;
      deferredActivations.delete(candidate);
    }
  }
  const deferred: DeferredAdapterActivation = {
    cancelled: false,
    started: false,
    retirementCompletion: flight.completion,
    cancellationCompletion: flight.cancellationCompletion,
    completion: Promise.resolve(),
  };
  const activation = flight.completion.then(async (report) => {
    if (deferred.cancelled || !teardownWasObserved(report.evidence) || !isCurrent() || hasRuntimeEntry()) return;
    deferred.started = true;
    await initialize(adapter, platformDefaults);
  });
  deferred.completion = activation;
  deferredActivations.set(adapter, deferred);
  void activation.then(
    () => {
      if (deferredActivations.get(adapter) === deferred) deferredActivations.delete(adapter);
    },
    (error) => {
      if (deferredActivations.get(adapter) === deferred) deferredActivations.delete(adapter);
      onError(error);
    },
  );
}

/**
 * Replace a deferred activation whose factory or predecessor completion still owns
 * an adapter name, without overlapping a new factory with that work.
 * @param deferredActivations - Per-definition activation promises used to serialize epochs.
 * @param adapter - Current replacement definition that supersedes the active epoch.
 * @param platformDefaults - Defaults forwarded to the eventual factory invocation.
 * @param isCurrent - Confirms the replacement still owns its adapter name.
 * @param initialize - Starts the normal registry initialization path.
 * @param onError - Reports a successor activation failure without leaking a rejection.
 * @returns True when an active predecessor was replaced by this successor.
 */
export function deferAdapterActivationAfterActive(
  deferredActivations: Map<LoadedAdapter, DeferredAdapterActivation>,
  adapter: LoadedAdapter,
  platformDefaults: PlatformDefaults,
  isCurrent: () => boolean,
  initialize: (adapter: LoadedAdapter, platformDefaults: PlatformDefaults) => Promise<void>,
  onError: (error: unknown) => void,
): boolean {
  if (!isCurrent() || deferredActivations.has(adapter)) return false;

  let predecessor: DeferredAdapterActivation | undefined;
  for (const [candidate, deferred] of deferredActivations) {
    if (candidate.name === adapter.name && !deferred.cancelled) predecessor = deferred;
  }
  if (predecessor === undefined) return false;

  predecessor.cancelled = true;
  const deferred: DeferredAdapterActivation = {
    cancelled: false,
    started: false,
    retirementCompletion: predecessor.retirementCompletion,
    cancellationCompletion: predecessor.completion.catch(() => undefined),
    completion: Promise.resolve(),
  };
  // The predecessor reports its own failure to its joiners. Its successor only
  // needs the rollback boundary to finish before it may attempt the current epoch.
  const activation = predecessor.completion
    .catch(() => undefined)
    .then(async () => {
      if (deferred.cancelled || !isCurrent()) return;
      deferred.started = true;
      await initialize(adapter, platformDefaults);
    });
  deferred.completion = activation;
  deferredActivations.set(adapter, deferred);
  void activation.then(
    () => {
      if (deferredActivations.get(adapter) === deferred) deferredActivations.delete(adapter);
    },
    (error) => {
      if (deferredActivations.get(adapter) === deferred) deferredActivations.delete(adapter);
      onError(error);
    },
  );
  return true;
}

/** One cancellable deferred activation keyed by loaded-definition identity. */
export interface DeferredAdapterActivation {
  /** True when package stop withdrew this definition before its flight settled. */
  cancelled: boolean;
  /** True once the continuation entered asynchronous adapter initialization. */
  started: boolean;
  /** Final evidence from the runtime flight currently blocking this activation. */
  retirementCompletion: AdapterRuntimeRetirementFlight['completion'];
  /** Boundary a waiting cancellation must join before it may remove tracking. */
  cancellationCompletion: Promise<void>;
  /** Completion of this activation and every predecessor it must wait to settle. */
  completion: Promise<void>;
}

/**
 * Cancel one exact definition epoch without affecting a replacement object.
 * @param deferredActivations - Activation promises keyed by definition identity.
 * @param adapter - Exact definition epoch to cancel.
 * @returns Cancellation state, or `undefined` when no activation was deferred.
 */
export function cancelDeferredAdapterActivation(
  deferredActivations: Map<LoadedAdapter, DeferredAdapterActivation>,
  adapter: LoadedAdapter,
): { readonly completion: Promise<void> } | undefined {
  const deferred = deferredActivations.get(adapter);
  if (deferred === undefined) return undefined;
  deferred.cancelled = true;
  if (!deferred.started) {
    deferredActivations.delete(adapter);
    return { completion: deferred.cancellationCompletion };
  }
  return { completion: deferred.completion };
}

/**
 * Order deregistration behind an exact deferred activation when one exists.
 * @param deferredActivations - Activations keyed by loaded-definition identity.
 * @param adapter - Exact definition being stopped.
 * @param isCurrent - Confirms the definition still owns its stable name.
 * @param getRuntimeEntry - Reads the runtime slot created or rolled back by activation.
 * @param removeDefinition - Removes definition and package tracking when no handle remains.
 * @returns True when deregistration is complete or a weak rollback must remain retryable.
 */
export async function settleDeferredAdapterDeregistration(
  deferredActivations: Map<LoadedAdapter, DeferredAdapterActivation>,
  adapter: LoadedAdapter,
  isCurrent: () => boolean,
  getRuntimeEntry: () => AdapterRuntimeEntry | undefined,
  removeDefinition: () => void,
): Promise<boolean> {
  const cancellation = cancelDeferredAdapterActivation(deferredActivations, adapter);
  if (cancellation === undefined) return false;
  await cancellation.completion.catch(() => undefined);
  if (!isCurrent()) return true;
  const entry = getRuntimeEntry();
  if (entry === undefined) {
    removeDefinition();
    return true;
  }
  if (entry.state !== 'retiring') return false;
  if (entry.flight !== undefined) {
    void entry.flight.completion.then((report) => {
      if (teardownWasObserved(report.evidence) && isCurrent() && getRuntimeEntry() === undefined) removeDefinition();
    });
  }
  return true;
}

/**
 * Cancel every deferred epoch and join their full activation chains.
 * @param deferredActivations - Iterable activation ownership held by the registry.
 */
export async function settleDeferredActivationsForShutdown(
  deferredActivations: Map<LoadedAdapter, DeferredAdapterActivation>,
): Promise<void> {
  const completions: Promise<void>[] = [];
  for (const deferred of deferredActivations.values()) {
    deferred.cancelled = true;
    completions.push((deferred.started ? deferred.completion : deferred.cancellationCompletion).catch(() => undefined));
  }
  await Promise.all(completions);
  deferredActivations.clear();
}
