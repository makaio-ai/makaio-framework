import { AllocationTerminationSchema, type ProviderAllocationRef, type WorkerHandle } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { recordLateAllocation, sameReference, type DispatchClaim } from './dispatch-store.js';
import { finishLocalAllocation, localWorkerControl, releaseProvisionHandle } from './local-worker-control.js';
import { isScopeApproved, lockDispatch } from './start-claim.js';
import type { WorkerStartOptions } from './start-order.js';

/**
 * Dispose of returned local control only after teardown or durable managed handoff.
 * @param host - Composed host.
 * @param call - Current supervision call.
 * @param claim - Settled dispatch.
 * @param returnedHandle - Control from the original provisioning invocation, if this is the sender.
 */
export async function finishLateAllocation(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  returnedHandle?: WorkerHandle,
): Promise<void> {
  const { jobRunId } = claim;
  const late = claim.settled?.lateAllocation;
  if (claim.binding.allocationLifetime === 'provider-managed' && late !== undefined) {
    try {
      // Shutdown cancels provisioning, but a returned allocation still needs teardown.
      const signal =
        returnedHandle !== undefined && host.operationSignal.aborted
          ? new AbortController().signal
          : host.operationSignal;
      // Sender and recovery can overlap, so both use the repeat-safe termination operation.
      if (
        late.state === 'pending' &&
        (await endByReference(host, call, claim, late.reference, signal).catch(() => false))
      ) {
        await recordLateTeardown(host, claim, late.reference);
      }
    } finally {
      await releaseProvisionHandle(returnedHandle);
    }
    return;
  }
  if (typeof returnedHandle?.terminate === 'function' && !host.handles.has(jobRunId)) {
    host.handles.set(jobRunId, localWorkerControl(returnedHandle));
  }
  await finishLocalAllocation(host, jobRunId);
}

/**
 * Record teardown alongside the original dispatch settlement.
 * @param host - Composed host.
 * @param claim - Dispatch with the pending late reference.
 * @param reference - The late allocation whose teardown was confirmed.
 */
async function recordLateTeardown(
  host: WorkerStartOptions,
  claim: DispatchClaim,
  reference: ProviderAllocationRef,
): Promise<void> {
  await host.database.transaction(async (tx) => {
    const current = await lockDispatch(tx, host, claim.jobRunId);
    const pending = current?.claim.settled?.lateAllocation;
    if (current !== undefined && pending?.state === 'pending' && sameReference(pending.reference, reference)) {
      await recordLateAllocation(tx, current.claim, { ...pending, state: 'ended' });
    }
  });
}

/**
 * Request teardown by reference while the persisted duty and scope are still current.
 * @param host - Composed host.
 * @param call - Current supervision call.
 * @param claim - Dispatch that owns the late allocation.
 * @param ref - Recorded candidate.
 * @param signal - Termination operation lifetime.
 * @returns Whether the provider confirmed teardown.
 */
async function endByReference(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  ref: ProviderAllocationRef,
  signal: AbortSignal,
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
    await provider.recovery.terminateAllocation(call, binding, ref, signal),
  );
  return termination.state === 'ended';
}
