import { AllocationTerminationSchema, type ProviderAllocationRef, type WorkerHandle } from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import type { OrderedWorkerRecovery } from '@makaio/contracts/extension';
import {
  mergeCandidates,
  recordLateAllocation,
  recordShutdownTeardown,
  sameReference,
  type DispatchClaim,
} from './dispatch-store.js';
import { finishLocalAllocation, localWorkerControl, releaseProvisionHandle } from './local-worker-control.js';
import { isScopeApproved, lockDispatch } from './start-claim.js';
import type { WorkerStartOptions } from './start-order.js';

/**
 * List durable cleanup duties backed by a settled send or a confirmed shutdown teardown.
 * @param claim - Current dispatch state.
 * @returns Exact references that still need teardown confirmation.
 */
export function pendingLateReferences(claim: DispatchClaim): readonly ProviderAllocationRef[] {
  const late = claim.settled?.lateAllocation;
  const sender = late?.state === 'pending' ? [late.reference] : [];
  const { shutdownEnded } = claim;
  return shutdownEnded === undefined
    ? sender
    : mergeCandidates(
        sender,
        claim.candidates.filter((ref) => !shutdownEnded.some((ended) => sameReference(ref, ended))),
      );
}

/**
 * Dispose of returned local control only after teardown or durable managed handoff.
 * @param host - Composed host.
 * @param call - Current supervision call.
 * @param claim - Dispatch with recorded cleanup evidence.
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
  if (
    claim.binding.allocationLifetime === 'provider-managed' &&
    (late !== undefined || claim.shutdownEnded !== undefined)
  ) {
    try {
      // Shutdown cancels provisioning, but a returned allocation still needs teardown.
      const signal =
        returnedHandle !== undefined && host.operationSignal.aborted
          ? new AbortController().signal
          : host.operationSignal;
      // Sender and recovery can overlap, so both use the repeat-safe termination operation.
      await Promise.all(
        pendingLateReferences(claim).map(async (ref) => {
          if (await endByReference(host, call, claim, ref, signal).catch(() => false)) {
            await recordLateTeardown(host, claim, ref);
          }
        }),
      );
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
 * Clean observed candidates under the applicable teardown rule.
 * @param host - Composed dispatch host.
 * @param call - Authorized supervision call.
 * @param recovery - Provider operations for the scoped observation.
 * @param claim - Snapshot after recording the observed candidates.
 * @returns Whether direct teardown calls confirmed every candidate they handled.
 */
export async function endObservedCandidates(
  host: WorkerStartOptions,
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  claim: DispatchClaim,
): Promise<boolean> {
  if (claim.shutdownEnded !== undefined) {
    // Once local shutdown took custody, every other candidate has an independent durable duty.
    await finishLateAllocation(host, call, claim);
    return true;
  }
  const results = await Promise.allSettled(
    claim.candidates.map(async (ref) =>
      AllocationTerminationSchema.parse(
        await recovery.terminateAllocation(call, claim.binding, ref, host.operationSignal),
      ),
    ),
  );
  return results.every((result) => result.status === 'fulfilled' && result.value.state === 'ended');
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
    const locked = await lockDispatch(tx, host, claim.jobRunId);
    if (locked === undefined) return;
    const current = locked.claim;
    const late = current.settled?.lateAllocation;
    if (late?.state === 'pending' && sameReference(late.reference, reference)) {
      await recordLateAllocation(tx, current, { reference, state: 'ended' });
    }
    if (
      current.shutdownEnded !== undefined &&
      !current.shutdownEnded.some((ref) => sameReference(ref, reference)) &&
      current.candidates.some((ref) => sameReference(ref, reference))
    ) {
      await recordShutdownTeardown(tx, current, reference);
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
    return (
      current !== undefined &&
      pendingLateReferences(current.claim).some((candidate) => sameReference(candidate, ref)) &&
      isScopeApproved(tx, host, binding)
    );
  });
  if (!approved) return false;
  const termination = AllocationTerminationSchema.parse(
    await provider.recovery.terminateAllocation(call, binding, ref, signal),
  );
  return termination.state === 'ended';
}
