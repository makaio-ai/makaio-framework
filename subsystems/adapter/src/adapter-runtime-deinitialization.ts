import type { IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects } from '@makaio/contracts';
import type { AdapterRetirementAttempt } from './adapter-runtime-lifecycle.js';

/** Exact runtime identity whose routing availability is being withdrawn. */
export interface DeinitializedAdapterIdentity {
  /** Runtime adapter instance ID. */
  readonly adapterId: string;
  /** Stable adapter implementation name. */
  readonly adapterName: string;
  /** Machine that hosts the runtime instance. */
  readonly machineId: string;
  /** Exact ownership-authority incarnation that hosts the runtime instance. */
  readonly ownerInstanceId: string;
}

/** One short-lived observation of an adapter's self-owned publication attempt. */
export interface DeinitializedAdapterObservation {
  /** Publish the registry fallback only when the instance did not attempt publication. */
  publishFallback(): Promise<void>;
  /** Stop observing once the close attempt has settled. */
  dispose(): void;
}

/**
 * Publish withdrawal of one registry-owned adapter identity without allowing a
 * subscriber failure to block registry cleanup.
 *
 * This is the registry-owned attempt used only when the adapter did not publish
 * for itself. Subscriber failure is reported but cannot block registry cleanup.
 * @param bus - Global adapter lifecycle bus.
 * @param identity - Exact instance identity being withdrawn.
 */
export async function publishAdapterDeinitializationBestEffort(
  bus: IMakaioBus,
  identity: DeinitializedAdapterIdentity,
): Promise<void> {
  try {
    await bus.emit(AdapterSubjects.deinitialized, identity);
  } catch (error) {
    console.warn(`[AdapterRuntimeRegistry] Failed to publish deinitialization for "${identity.adapterName}":`, error);
  }
}

/**
 * Observe publication ownership for one close attempt and exact adapter identity.
 *
 * Observation proves only that the adapter owned and made the publication
 * attempt, not that every local or remote subscriber received it. Retrying a
 * self-owned attempt cannot guarantee delivery and would violate the exact-once
 * lifecycle contract, so the registry falls back only when no attempt occurred.
 * @param bus - Global adapter lifecycle bus.
 * @param identity - Exact instance identity being closed.
 * @param onAttemptObserved - Withdraw the exact instance from live routing.
 * @returns Observation used to conditionally publish the registry fallback.
 */
export function observeAdapterDeinitialization(
  bus: IMakaioBus,
  identity: DeinitializedAdapterIdentity,
  onAttemptObserved: () => void = () => undefined,
): DeinitializedAdapterObservation {
  let attemptObserved = false;
  const cleanup = bus.on(AdapterSubjects.deinitialized, (context) => {
    const payload = context.payload;
    const matchesIdentity =
      payload.adapterId === identity.adapterId &&
      payload.adapterName === identity.adapterName &&
      payload.machineId === identity.machineId &&
      payload.ownerInstanceId === identity.ownerInstanceId;
    if (!attemptObserved && matchesIdentity) {
      attemptObserved = true;
      onAttemptObserved();
    }
  });

  return {
    async publishFallback(): Promise<void> {
      if (!attemptObserved) await publishAdapterDeinitializationBestEffort(bus, identity);
    },
    dispose: cleanup,
  };
}

/**
 * Close an adapter and publish the registry fallback when the adapter did not.
 * @param bus - Global adapter lifecycle bus.
 * @param identity - Exact instance identity being closed.
 * @param close - Close operation whose classified attempt permits fallback publication.
 * @param onWithdrawalObserved - Withdraw the exact instance from live routing as soon as publication is observed.
 * @returns The close attempt including any close/publication flight still in progress.
 */
export async function closeAdapterWithDeinitializationFallback(
  bus: IMakaioBus,
  identity: DeinitializedAdapterIdentity,
  close: () => Promise<AdapterRetirementAttempt>,
  onWithdrawalObserved: () => void,
): Promise<AdapterRetirementAttempt> {
  const observation = observeAdapterDeinitialization(bus, identity, onWithdrawalObserved);
  let completionOwnsObservation = false;
  try {
    const attempt = await close();
    if (attempt.pendingCompletion !== undefined) {
      // The hook can still self-publish after the close budget. Hold the exact
      // observation until it settles so a fallback cannot duplicate that event.
      completionOwnsObservation = true;
      const pendingCompletion = attempt.pendingCompletion
        .then(async (lateReport) => {
          await observation.publishFallback();
          return lateReport;
        })
        .finally(() => observation.dispose())
        .then(
          (lateReport) => lateReport,
          () => attempt.report,
        );
      return { report: attempt.report, pendingCompletion };
    }
    await observation.publishFallback();
    return { report: attempt.report };
  } finally {
    if (!completionOwnsObservation) observation.dispose();
  }
}

/**
 * Start a retirement attempt, adding deinitialization ownership only for a previously live slot.
 * @param bus - Global lifecycle bus.
 * @param identity - Exact instance identity for a possible fallback withdrawal.
 * @param close - Classified close attempt owned by the retirement flight.
 * @param publishDeinitialization - Whether a prior initialized publication may need withdrawal.
 * @returns Classified attempt, including any pending close/publication completion.
 */
export function startAdapterRetirementAttempt(
  bus: IMakaioBus,
  identity: DeinitializedAdapterIdentity,
  close: () => Promise<AdapterRetirementAttempt>,
  publishDeinitialization: boolean,
): Promise<AdapterRetirementAttempt> {
  return publishDeinitialization
    ? closeAdapterWithDeinitializationFallback(bus, identity, close, () => undefined)
    : close();
}
