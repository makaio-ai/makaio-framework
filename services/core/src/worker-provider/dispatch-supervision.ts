import {
  AllocationTerminationSchema,
  PRE_REQUEST_REJECTION_CODE,
  BoundedRecoveryEvidenceSchema,
  type BoundedRecoveryEvidence,
  type JobRunId,
  type ProviderAllocationRef,
  type WorkerHandle,
} from '@makaio/contracts';
import type { CallContext } from '@makaio/core';
import { hasOpenDeadline, isScopeApproved, lockDispatch } from './start-claim.js';
import {
  type DispatchClaim,
  mergeCandidates,
  recordLateAllocation,
  sameReference,
  updateDispatch,
} from './dispatch-store.js';
import {
  observeLiveAllocation,
  observeManaged,
  parseReference,
  type ManagedDispatch,
  type ManagedObservation,
  trustedObservationReference,
} from './dispatch-observation.js';
import {
  finishLateProvisionHandle,
  finishLocalAllocation,
  localWorkerControl,
  releaseProvisionHandle,
  UNBOUND_PROCESS_TERMINATION_CODE,
} from './local-worker-control.js';
import { finishLateAllocation } from './late-allocation.js';
import type {
  OrderedProvisionOutcome,
  OrderedProvisionRequest,
  OrderedWorkerRecovery,
} from '@makaio/contracts/extension';
import type { StartWorkerResult, WorkerStartOptions } from './start-order.js';
import type { StartDecision } from './start-claim.js';

export const unresolved = { kind: 'unknown', reason: 'dispatch-unresolved' } as const;
export const unavailable = { kind: 'unknown', reason: 'observation-unavailable' } as const;

const discoveryConflict = { kind: 'unknown', reason: 'allocation-conflict', cleanupRequired: true } as const;

/**
 * Return only the result that current durable evidence supports.
 * @param claim - Stored claim.
 * @returns The public result supported by this claim.
 */
function resultOf(claim: DispatchClaim): StartWorkerResult {
  if (claim.candidates.length > 1) return { kind: 'unknown', reason: 'allocation-conflict' };
  // A binding records the allocation that was assigned. Settlement closes the cleanup duty.
  if (claim.boundAllocation !== null) return { kind: 'allocated', allocationRef: claim.boundAllocation };
  if (
    claim.settled !== null &&
    claim.candidates.length === 0 &&
    (claim.binding.allocationLifetime === 'provider-managed' ||
      claim.settled.code === PRE_REQUEST_REJECTION_CODE ||
      claim.settled.code === UNBOUND_PROCESS_TERMINATION_CODE)
  ) {
    const { lateAllocation: _lateAllocation, ...evidence } = claim.settled;
    return { kind: 'confirmed-absent', evidence };
  }
  return unresolved;
}

/**
 * Invoke the provider after acknowledgment of the winning transaction.
 * @param host - Host for the winning claim.
 * @param call - Authorized order owner.
 * @param decision - Winning claim and volatile start values.
 * @returns The result before sending, or the provider work and its caller wait window.
 */
export async function dispatchWinner(
  host: WorkerStartOptions,
  call: CallContext,
  decision: Extract<StartDecision, { kind: 'dispatch' }>,
): Promise<StartWorkerResult | { outcome: Promise<StartWorkerResult>; remaining: number | undefined }> {
  if (host.operationSignal.aborted || host.provisionDrain?.closed.aborted)
    return settlePreRequestRejection(host, decision.claim);
  const current = await host.database.transaction(async (tx) => {
    const locked = await lockDispatch(tx, host, decision.claim.jobRunId);
    if (locked === undefined) return undefined;
    const deadline = locked.order.order.bootstrapDeadlineAt;
    return { ...locked, withinDeadline: hasOpenDeadline(deadline) };
  });
  if (current === undefined) return unresolved;
  if (host.operationSignal.aborted || host.provisionDrain?.closed.aborted)
    return settlePreRequestRejection(host, current.claim);
  if (current.claim.settled === null && current.order.state !== 'ordered')
    return settlePreRequestRejection(host, current.claim);
  const remaining = Date.parse(current.order.order.bootstrapDeadlineAt) - Date.now();
  if (current.claim.settled !== null || !current.withinDeadline || remaining <= 0)
    return { outcome: observeDispatch(host, call, { ...current, kind: 'observe' }), remaining: undefined };
  let request: OrderedProvisionRequest;
  try {
    request = { ...decision.material, connection: host.connection() };
    host.operationSignal.throwIfAborted();
  } catch {
    return settlePreRequestRejection(host, current.claim);
  }
  return { outcome: sendProvision(host, call, decision, request), remaining };
}

/**
 * Send outside the run transaction and supervise the returned allocation.
 * @param host - Composed host.
 * @param call - Authorized order owner.
 * @param decision - Winning dispatch and volatile material.
 * @param request - Provider request prepared before handing off the claim.
 * @returns The result of recording the sole sender's outcome.
 */
async function sendProvision(
  host: WorkerStartOptions,
  call: CallContext,
  decision: Extract<StartDecision, { kind: 'dispatch' }>,
  request: OrderedProvisionRequest,
): Promise<StartWorkerResult> {
  const { provider, claim } = decision;
  let outcome: OrderedProvisionOutcome | undefined;
  try {
    outcome = await provider.provision(call, request, host.operationSignal);
  } catch {
    return settleWithoutAllocation(host, claim);
  }
  if (outcome?.kind === 'confirmed-absent') {
    const evidence = BoundedRecoveryEvidenceSchema.safeParse(outcome.evidence);
    if (!evidence.success || evidence.data.code !== PRE_REQUEST_REJECTION_CODE)
      return settleWithoutAllocation(host, claim);
    if (host.provisionDrain?.closed.aborted) return unresolved;
    return settlePreRequestRejection(host, claim, evidence.data);
  }
  if (outcome?.kind !== 'allocated') return settleWithoutAllocation(host, claim);
  return finishProvision(host, call, claim, outcome);
}

/**
 * Persist evidence that the dispatch made no provisioning request.
 * @param host - Composed host.
 * @param claim - Winning dispatch.
 * @param evidence - Pre-request rejection evidence, defaulting to a host-side rejection.
 * @returns The durable result.
 */
async function settlePreRequestRejection(
  host: WorkerStartOptions,
  claim: DispatchClaim,
  evidence: BoundedRecoveryEvidence = {
    code: PRE_REQUEST_REJECTION_CODE,
    source: 'worker-dispatch',
    summary: 'Provisioning could not start',
    observedAt: new Date().toISOString(),
  },
): Promise<StartWorkerResult> {
  return host.database.transaction(async (tx) => {
    const current = await lockDispatch(tx, host, claim.jobRunId);
    if (current === undefined || current.claim.candidates.length !== 0) return unresolved;
    return resultOf(
      await updateDispatch(tx, current.claim, {
        sendSettled: true,
        settled: current.claim.settled ?? evidence,
      }),
    );
  });
}

/**
 * Record sender completion when it returned no usable allocation.
 * @param host - Composed host.
 * @param claim - Winning dispatch.
 * @returns The durable result.
 */
async function settleWithoutAllocation(host: WorkerStartOptions, claim: DispatchClaim): Promise<StartWorkerResult> {
  const current = await recordSendSettled(host, claim);
  return current === undefined ? unresolved : resultOf(current.claim);
}

/**
 * Verify that a returned handle can establish the allocation's run binding.
 * @param handle - Control returned by the provider.
 * @param jobRunId - Run the returned control must own.
 * @returns Whether the handle can bind the allocation to this run.
 */
function canBindHandle(handle: WorkerHandle, jobRunId: JobRunId): boolean {
  return (
    typeof handle?.terminate === 'function' &&
    typeof handle.release === 'function' &&
    typeof handle.cancel === 'function' &&
    handle.executionId === jobRunId
  );
}

/**
 * Transfer a returned allocation to supervision or clean it up after closure or settlement.
 * @param host - Composed host.
 * @param call - Authorized order owner.
 * @param claim - Winning dispatch.
 * @param outcome - Allocation returned by the provider.
 * @returns The durable result.
 */
async function finishProvision(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  outcome: Extract<OrderedProvisionOutcome, { kind: 'allocated' }>,
): Promise<StartWorkerResult> {
  const drainClosed = () => host.provisionDrain?.closed.aborted === true;
  const { binding, jobRunId } = claim;
  const ref = parseReference(binding.providerId, outcome.allocationRef);
  const { handle } = outcome;
  const canTerminate = typeof handle?.terminate === 'function';
  const bound = canBindHandle(handle, jobRunId) ? ref : undefined;
  const processBound = binding.allocationLifetime === 'provisioner-process-bound';
  const finishLate = async () => {
    // The provision call owns local teardown even if its handle cannot establish a binding.
    await finishLateProvisionHandle(
      host,
      jobRunId,
      handle,
      processBound
        ? { managed: false, reference: ref, matchesRun: handle?.executionId === jobRunId }
        : { managed: true, reference: bound },
    );
    return unresolved;
  };
  if (drainClosed() && (processBound || ref === undefined)) return finishLate();
  let retained = processBound && canTerminate;
  // Take custody before storage can stall. Shutdown can then find the handle even if recording never returns.
  if (retained) host.handles.set(jobRunId, localWorkerControl(handle));
  const retainManaged =
    !processBound && bound !== undefined
      ? () => {
          host.handles.set(jobRunId, localWorkerControl(handle, bound));
          retained = true;
        }
      : undefined;
  const current = await recordSendSettled(host, claim, ref, bound, retainManaged).catch(async (error: unknown) => {
    if (drainClosed()) return undefined;
    if (!processBound && retained) host.handles.delete(jobRunId);
    if (!processBound || !retained) await releaseProvisionHandle(handle);
    throw error;
  });
  if (drainClosed()) {
    if (retained) return unresolved;
    if (!processBound && current?.claim.settled?.lateAllocation !== undefined) {
      // Storage may close after termination. The durable reference remains available for recovery.
      await finishLateAllocation(host, call, current.claim, handle).catch(() => undefined);
      return unresolved;
    }
    // A rejected managed reference write may have committed before its acknowledgment was lost.
    // Fall back to the handle despite the risk of repeating termination, since the worker may have no durable record.
    return finishLate();
  }
  if (!processBound && retained) host.handles.delete(jobRunId);
  if (processBound && !canTerminate) throw new TypeError('Process-bound worker handle requires terminate()');
  return superviseProvisionResult(host, call, claim, handle, current, bound);
}

/**
 * Supervise a returned handle once provisioning storage has acknowledged it.
 * @param host - Composed host.
 * @param call - Authorized order owner.
 * @param claim - Winning dispatch.
 * @param handle - Control returned by the provider.
 * @param current - Acknowledged dispatch and order state.
 * @param bound - Reference validated against the returned handle.
 * @returns The result supported by the acknowledged state.
 */
async function superviseProvisionResult(
  host: WorkerStartOptions,
  call: CallContext,
  claim: DispatchClaim,
  handle: WorkerHandle,
  current: Awaited<ReturnType<typeof recordSendSettled>>,
  bound: ProviderAllocationRef | undefined,
): Promise<StartWorkerResult> {
  const { binding, jobRunId } = claim;
  const processBound = binding.allocationLifetime === 'provisioner-process-bound';
  const result = current === undefined ? unresolved : resultOf(current.claim);
  if (current !== undefined && current.claim.settled !== null) {
    await finishLateAllocation(host, call, current.claim, processBound ? undefined : handle);
    return result;
  }
  try {
    if (current?.order.state === 'closed') return await observeDispatch(host, call, { ...current, kind: 'observe' });
    // The provision call owns its local handle even if its run metadata is unusable for binding.
    if (processBound && bound === undefined) await finishLocalAllocation(host, jobRunId);
    return result;
  } finally {
    if (!processBound) await releaseProvisionHandle(handle);
  }
}

/**
 * Record that the only send-capable invocation has settled and retain its candidate.
 * @param host - Composed host.
 * @param claim - Dispatch whose provider invocation settled.
 * @param ref - Valid candidate even if the returned handle cannot establish a binding.
 * @param bound - Candidate whose handle confirms the run identity.
 * @param retainBound - Gives shutdown custody before a managed binding write can stall.
 * @returns The persisted dispatch and the order snapshot read under the same lock.
 */
async function recordSendSettled(
  host: WorkerStartOptions,
  claim: DispatchClaim,
  ref?: ProviderAllocationRef,
  bound?: ProviderAllocationRef,
  retainBound?: () => void,
) {
  const canRecordAfterDrain = ref !== undefined && claim.binding.allocationLifetime === 'provider-managed';
  if (host.provisionDrain?.closed.aborted && !canRecordAfterDrain) return undefined;
  return host.database.transaction(async (tx) => {
    const current = await lockDispatch(tx, host, claim.jobRunId);
    if (current === undefined) return undefined;
    const previous = current.claim;
    // Once the drain closes, only a settled dispatch needs a separate late reference for recovery.
    if (host.provisionDrain?.closed.aborted && (!canRecordAfterDrain || previous.settled === null)) return undefined;
    if (previous.settled !== null) {
      if (ref === undefined) return current;
      const locallyEnded =
        previous.binding.allocationLifetime === 'provisioner-process-bound' &&
        previous.settled.code !== PRE_REQUEST_REJECTION_CODE;
      const updated = await recordLateAllocation(tx, previous, {
        reference: ref,
        state: locallyEnded ? 'ended' : 'pending',
      });
      return { ...current, claim: updated };
    }
    const boundAllocation = previous.boundAllocation ?? bound ?? null;
    if (bound !== undefined && boundAllocation !== null && sameReference(boundAllocation, bound)) retainBound?.();
    const updated = await updateDispatch(tx, previous, {
      sendSettled: true,
      candidates: ref === undefined ? previous.candidates : mergeCandidates(previous.candidates, [ref]),
      boundAllocation,
    });
    return { ...current, claim: updated };
  });
}

/**
 * Apply an observation to a claim before making any destructive calls.
 * @param host - Composed host.
 * @param claim - Observed dispatch.
 * @param observation - Positive references and any send fence.
 * @param proven - Early reference with live evidence, if available.
 * @returns The latest claim and whether this observation permits termination.
 */
export async function recordObservation(
  host: WorkerStartOptions,
  claim: DispatchClaim,
  observation: ManagedObservation,
  proven: number | undefined,
) {
  return host.database.transaction(async (tx) => {
    const locked = await lockDispatch(tx, host, claim.jobRunId);
    if (locked === undefined) return undefined;
    const current = locked.claim;
    if (current.settled !== null) return { updated: current, mayTerminate: false };
    const candidates = mergeCandidates(current.candidates, observation.candidates);
    // Under the run lock, a new binding requires the proven reference to remain the sole candidate.
    // A conflicting reference recorded during the proof leaves the merged set ineligible for binding.
    const ref = trustedObservationReference(current, observation, candidates);
    const canBind = locked.order.state !== 'closed' && proven !== undefined && proven > Date.now();
    const boundAllocation = current.boundAllocation ?? (canBind ? ref : undefined) ?? null;
    const absent = !observation.foreignDiscovery && candidates.length === 0 && observation.seal?.refs.length === 0;
    const updated = await updateDispatch(tx, current, {
      candidates,
      boundAllocation,
      ...(absent ? { settled: observation.seal?.evidence } : {}),
    });
    const mayTerminate =
      locked.order.state === 'closed' &&
      candidates.length > 0 &&
      current.binding.allocationLifetime === 'provider-managed' &&
      (await isScopeApproved(tx, host, current.binding));
    return { updated, mayTerminate };
  });
}

/**
 * Clean up every positively matched candidate, including a late conflicting reference.
 * @param host - Composed host.
 * @param call - Current supervision call.
 * @param recovery - Frozen provider instance operations.
 * @param claim - Latest observed dispatch.
 * @param observation - Scoped provider observation.
 * @returns The latest claim with cleanup evidence when complete.
 */
async function cleanManaged(
  host: WorkerStartOptions,
  call: CallContext,
  recovery: OrderedWorkerRecovery,
  claim: DispatchClaim,
  observation: ManagedObservation,
): Promise<DispatchClaim> {
  const results = await Promise.allSettled(
    claim.candidates.map(async (ref) =>
      AllocationTerminationSchema.parse(
        await recovery.terminateAllocation(call, claim.binding, ref, host.operationSignal),
      ),
    ),
  );
  const seal = observation.seal;
  if (
    observation.foreignDiscovery ||
    seal === undefined ||
    !results.every((result) => result.status === 'fulfilled' && result.value.state === 'ended') ||
    !claim.candidates.every((candidate) => seal.refs.some((ref) => sameReference(ref, candidate)))
  )
    return claim;
  return host.database.transaction(async (tx) => {
    const current = await lockDispatch(tx, host, claim.jobRunId);
    if (current === undefined || current.claim.candidates.length !== claim.candidates.length) return claim;
    return updateDispatch(tx, current.claim, { settled: seal.evidence });
  });
}

/**
 * Observe an existing dispatch. This path cannot send a provision request.
 * @param host - Composed host.
 * @param call - Current supervision call.
 * @param decision - Durable claim and locked run state.
 * @returns The available infrastructure evidence for the existing dispatch.
 */
export async function observeDispatch(
  host: WorkerStartOptions,
  call: CallContext,
  decision: Extract<StartDecision, { kind: 'observe' }>,
): Promise<StartWorkerResult> {
  const { claim, order } = decision;
  if (claim.settled !== null) {
    if (
      claim.binding.allocationLifetime === 'provider-managed' ||
      claim.binding.processIncarnation === host.processIncarnation
    ) {
      await finishLateAllocation(host, call, claim);
    }
    return resultOf(claim);
  }
  if (claim.binding.allocationLifetime === 'provisioner-process-bound') {
    if (order.state === 'closed' && claim.binding.processIncarnation === host.processIncarnation) {
      await finishLocalAllocation(host, claim.jobRunId);
    }
    return resultOf(claim);
  }
  return observeManagedDispatch(host, call, decision, claim.binding);
}

/**
 * Observe and, after closure, clean up a correlated provider-managed allocation.
 * @param host - Composed host.
 * @param call - Authorized order owner.
 * @param decision - Durable claim and locked run state.
 * @param binding - Provider-managed dispatch binding.
 * @returns The observation and any safe attach diagnostic.
 */
async function observeManagedDispatch(
  host: WorkerStartOptions,
  call: CallContext,
  decision: Extract<StartDecision, { kind: 'observe' }>,
  binding: ManagedDispatch,
): Promise<StartWorkerResult> {
  const { claim, order } = decision;
  const provider = host.providers.get(claim.binding.providerId);
  if (provider?.allocationLifetime !== 'provider-managed') return unavailable;
  const observation = await observeManaged(
    call,
    provider.recovery,
    binding,
    host.operationSignal,
    claim.sendSettled || !hasOpenDeadline(order.order.bootstrapDeadlineAt),
  );
  const candidates = mergeCandidates(claim.candidates, observation.candidates);
  const ref = trustedObservationReference(claim, observation, candidates);
  const proof =
    order.state !== 'closed' && ref !== undefined
      ? await observeLiveAllocation(
          call,
          provider.recovery,
          claim,
          ref,
          host.operationSignal,
          claim.boundAllocation === null,
        )
      : {};
  const recorded = await recordObservation(host, claim, observation, proof.liveThrough);
  if (recorded === undefined) return unresolved;
  const { updated, mayTerminate } = recorded;
  if (updated.settled !== null) return resultOf(updated);
  const result = resultOf(
    mayTerminate ? await cleanManaged(host, call, provider.recovery, updated, observation) : updated,
  );
  if (observation.foreignDiscovery) return discoveryConflict;
  if (proof.lastAttachFailure !== undefined) return { ...result, lastAttachFailure: proof.lastAttachFailure };
  return result.kind === 'unknown' && result.reason === 'dispatch-unresolved' && !observation.observedPage
    ? unavailable
    : result;
}
