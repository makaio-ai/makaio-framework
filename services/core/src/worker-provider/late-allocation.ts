import {
  AllocationTerminationSchema,
  type JobRunId,
  type ProviderAllocationRef,
  type WorkerHandle,
} from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { recordLateAllocation, sameReference, type DispatchClaim } from './dispatch-store.js';
import { isScopeApproved, lockDispatch } from './start-claim.js';
import type { WorkerStartOptions } from './start-order.js';

/**
 * Dispose of returned local control only after teardown or durable managed handoff.
 * @param host - Composed host.
 * @param handles - Local control retained when teardown cannot be handed off.
 * @param call - Current supervision call.
 * @param claim - Settled dispatch.
 * @param returnedHandle - Control from the original provisioning invocation, if this is the sender.
 */
export async function finishLateAllocation(
  host: WorkerStartOptions,
  handles: Map<JobRunId, WorkerHandle>,
  call: CallContext,
  claim: DispatchClaim,
  returnedHandle?: WorkerHandle,
): Promise<void> {
  const { jobRunId } = claim;
  const handle = returnedHandle ?? handles.get(jobRunId);
  const late = claim.settled?.lateAllocation;
  if (handle === undefined && late?.state !== 'pending') return;
  handles.delete(jobRunId);
  const recoverable = claim.binding.allocationLifetime === 'provider-managed' && late !== undefined;
  try {
    if ((await endLateAllocation(host, call, claim, handle)) || recoverable) {
      if (typeof handle?.release === 'function') await handle.release().catch(() => undefined);
    } else if (typeof handle?.terminate === 'function') {
      handles.set(jobRunId, handle);
    }
  } catch (error) {
    if (typeof handle?.terminate === 'function') handles.set(jobRunId, handle);
    throw error;
  }
}

/**
 * End an allocation returned after settlement, independently of the run's result.
 * The returned handle owns the allocation. A later observer can instead recover
 * a persisted reference under the installation's confirmed scope.
 * @param host - Composed host.
 * @param call - Current supervision call.
 * @param claim - Dispatch with its original settlement and optional late reference.
 * @param handle - Control returned by the original provisioning invocation.
 * @returns Whether teardown was confirmed.
 */
async function endLateAllocation(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  handle?: WorkerHandle,
): Promise<boolean> {
  const late = claim.settled?.lateAllocation;
  try {
    if (typeof handle?.terminate === 'function') {
      await handle.terminate();
    } else if (late?.state === 'pending') {
      if (!(await endByReference(host, call, claim, late.reference))) return false;
    } else {
      return false;
    }
  } catch {
    return false;
  }
  if (late !== undefined) {
    await host.database.transaction(async (tx) => {
      const current = await lockDispatch(tx, host, claim.jobRunId);
      const pending = current?.claim.settled?.lateAllocation;
      if (current !== undefined && pending?.state === 'pending' && sameReference(pending.reference, late.reference)) {
        await recordLateAllocation(tx, current.claim, { ...late, state: 'ended' });
      }
    });
  }
  return true;
}

/**
 * Request teardown by reference while the persisted duty and scope are still current.
 * @param host - Composed host.
 * @param call - Current supervision call.
 * @param claim - Dispatch that owns the late allocation.
 * @param ref - Recorded candidate.
 * @returns Whether the provider confirmed teardown.
 */
async function endByReference(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  ref: ProviderAllocationRef,
): Promise<boolean> {
  const { binding } = claim;
  const provider = host.providers.get(binding.providerId);
  if (binding.allocationLifetime !== 'provider-managed' || provider?.allocationLifetime !== 'provider-managed') {
    return false;
  }
  const approved = await host.database.transaction(async (tx) => {
    const current = await lockDispatch(tx, host, claim.jobRunId);
    const late = current?.claim.settled?.lateAllocation;
    return late?.state === 'pending' && sameReference(late.reference, ref) && isScopeApproved(tx, host, binding);
  });
  if (!approved) return false;
  const termination = AllocationTerminationSchema.parse(
    await provider.recovery.terminateAllocation(call, binding, ref, host.operationSignal),
  );
  return termination.state === 'ended';
}
