import type { JobRunId, ProviderAllocationRef, WorkerHandle } from '@makaio/contracts';
import {
  type DispatchClaim,
  recordLateAllocation,
  recordShutdownTeardown,
  sameReference,
  updateDispatch,
} from './dispatch-store.js';
import { lockDispatch } from './start-claim.js';
import type { WorkerStartOptions } from './start-order.js';

/** A local handle and the shared teardown state for one allocation. */
export type LocalWorkerControl = ReturnType<typeof localWorkerControl>;

/** Durable completion of a process-bound provision that never acquired a binding. */
export const UNBOUND_PROCESS_TERMINATION_CODE = 'unbound-process-termination';

type LateProvision =
  | { managed: true; reference: ProviderAllocationRef | undefined }
  | { managed: false; reference: ProviderAllocationRef | undefined; matchesRun: boolean };

/**
 * Share teardown between observers and remember confirmation across storage retries.
 * @param handle - Local infrastructure control returned by the provider.
 * @param managedReference - Managed binding awaiting durable handoff, when applicable.
 * @returns Control that serializes teardown and releases only after handoff.
 */
export function localWorkerControl(handle: WorkerHandle, managedReference?: ProviderAllocationRef) {
  let terminated = false;
  let finishing: Promise<boolean> | undefined;

  return {
    managedReference,
    /**
     * Confirm termination and record it, sharing any concurrent completion attempt.
     * @param record - Persists teardown evidence and confirms durable completion.
     * @returns Whether the host may discard its control.
     */
    finish(record: () => Promise<boolean>): Promise<boolean> {
      finishing ??= Promise.resolve()
        .then(async () => {
          if (!terminated) {
            await handle.terminate();
            terminated = true;
          }
          if (!(await record())) return false;
          await releaseProvisionHandle(handle);
          return true;
        })
        .then(
          (finished) => {
            if (!finished) finishing = undefined;
            return finished;
          },
          (error: unknown) => {
            finishing = undefined;
            throw error;
          },
        );
      return finishing;
    },
  };
}

/**
 * Complete local teardown through the same durable path for supervision and host shutdown.
 * @param host - Owner of the handle registry and dispatch database.
 * @param jobRunId - Dispatch whose local allocation is being torn down.
 * @returns Whether local ownership was durably resolved.
 */
export async function finishLocalAllocation(host: WorkerStartOptions, jobRunId: JobRunId): Promise<boolean> {
  const control = host.handles.get(jobRunId);
  if (control === undefined) return true;
  const finished = await control.finish(() => recordLocalTeardown(host, jobRunId, control.managedReference));
  if (finished) host.handles.delete(jobRunId);
  return finished;
}

/**
 * Release a returned provider handle without changing the dispatch outcome.
 * @param handle - Returned provider control, when present.
 */
export async function releaseProvisionHandle(handle: WorkerHandle | undefined): Promise<void> {
  try {
    await handle?.release?.();
  } catch {
    // The outcome is determined by durable dispatch evidence.
  }
}

/**
 * Finish a handle returned after the provision drain without adding it to the shutdown snapshot.
 * @param host - Dispatch host whose storage may still be open.
 * @param jobRunId - Run that sent the provider request.
 * @param handle - Returned allocation control.
 * @param returned - Validated reference and identity of the returned allocation.
 */
export async function finishLateProvisionHandle(
  host: WorkerStartOptions,
  jobRunId: JobRunId,
  handle: WorkerHandle,
  returned: LateProvision,
): Promise<void> {
  await localWorkerControl(handle).finish(async () => {
    const { reference } = returned;
    if (reference !== undefined || (!returned.managed && returned.matchesRun)) {
      // Shutdown may have closed storage. If recording fails, the durable duty stays open.
      await recordLocalTeardown(host, jobRunId, returned.managed ? reference : undefined, returned).catch(
        () => undefined,
      );
    }
    return true;
  });
}

/**
 * Correlate teardown with the durable binding or, for an unbound late reply, its run identity.
 * @param claim - Dispatch read under the run lock.
 * @param managed - Managed allocation awaiting handoff, when applicable.
 * @param returned - Late reply identity, when supplied.
 * @param hostIncarnation - Current host process identity for unbound late replies.
 * @returns Whether the control represents the claim's allocation.
 */
function matchesTeardownAllocation(
  claim: DispatchClaim,
  managed: ProviderAllocationRef | undefined,
  returned: LateProvision | undefined,
  hostIncarnation: string,
): boolean {
  if (managed === undefined && returned === undefined) return true;
  if (claim.boundAllocation === null) {
    const { binding } = claim;
    return (
      claim.settled === null &&
      returned?.managed === false &&
      returned.matchesRun &&
      binding.allocationLifetime === 'provisioner-process-bound' &&
      binding.processIncarnation === hostIncarnation
    );
  }
  const reference = returned?.reference ?? managed;
  return (
    reference !== undefined &&
    sameReference(claim.boundAllocation, reference) &&
    (managed === undefined || claim.candidates.length === 1)
  );
}

/**
 * Persist confirmed local teardown for a held handle or a correlated late reply.
 * @param host - Dispatch host.
 * @param jobRunId - Run whose allocation was terminated.
 * @param managed - Managed allocation awaiting handoff, when applicable.
 * @param returned - Late reply identity to check against the claim.
 * @returns Whether the recording phase completed.
 */
async function recordLocalTeardown(
  host: WorkerStartOptions,
  jobRunId: JobRunId,
  managed: ProviderAllocationRef | undefined,
  returned?: LateProvision,
): Promise<boolean> {
  // The scheduled cleanup fence can close while storage is still available to a late reply.
  const fence = returned === undefined ? host.localCleanupSignal : undefined;
  if (fence?.aborted) return false;
  return host.database.transaction(async (tx) => {
    const current = await lockDispatch(tx, host, jobRunId);
    if (current === undefined || fence?.aborted) return false;
    const { claim } = current;
    // A managed handle confirms exactly its allocation. Only the provider can fence further discovery.
    if (managed !== undefined && current.order.redemption !== undefined && claim.settled === null) {
      if (claim.sendSettled && claim.candidates.some((candidate) => sameReference(candidate, managed))) {
        await recordShutdownTeardown(tx, claim, managed);
      }
      return true;
    }
    if (!matchesTeardownAllocation(claim, managed, returned, host.processIncarnation)) return true;
    const unboundProcessReply = claim.boundAllocation === null && returned?.managed === false;
    const late = claim.settled?.lateAllocation;
    if (late?.state === 'pending') {
      await recordLateAllocation(tx, claim, { ...late, state: 'ended' });
    } else if (claim.settled === null) {
      await updateDispatch(tx, claim, {
        sendSettled: true,
        settled: {
          ...(unboundProcessReply ? { code: UNBOUND_PROCESS_TERMINATION_CODE } : {}),
          source: 'worker-dispatch',
          summary:
            managed === undefined
              ? 'Process-bound allocation terminated'
              : 'Managed allocation terminated during shutdown',
          observedAt: new Date().toISOString(),
        },
      });
    }
    return true;
  });
}
