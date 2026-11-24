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
import { boundedWait } from '@makaio/utils';
import { hasOpenDeadline, isScopeApproved, lockDispatch } from './start-claim.js';
import {
  type DispatchClaim,
  mergeCandidates,
  recordLateAllocation,
  sameReference,
  updateDispatch,
} from './dispatch-store.js';
import { observeManaged, parseReference, proveUniqueLive, type ManagedObservation } from './dispatch-observation.js';
import { finishLateAllocation } from './late-allocation.js';
import type { OrderedProvisionOutcome, OrderedProvisionRequest, OrderedWorkerRecovery } from './ordered-provider.js';
import type { StartWorkerResult, WorkerStartOptions } from './start-order.js';
import type { StartDecision } from './start-claim.js';

export const unresolved = { kind: 'unknown', reason: 'dispatch-unresolved' } as const;
export const unavailable = { kind: 'unknown', reason: 'observation-unavailable' } as const;

type LocalHandles = Map<JobRunId, WorkerHandle>;

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
    (claim.binding.allocationLifetime === 'provider-managed' || claim.settled.code === PRE_REQUEST_REJECTION_CODE)
  ) {
    const { lateAllocation: _lateAllocation, ...evidence } = claim.settled;
    return { kind: 'confirmed-absent', evidence };
  }
  return unresolved;
}

/**
 * Invoke the provider after acknowledgment of the winning transaction.
 * @param host - Host for the winning claim.
 * @param handles - Local control for process-bound allocations.
 * @param call - Authorized order owner.
 * @param decision - Winning claim and volatile start values.
 * @returns The committed provider outcome or retained uncertainty.
 */
export async function dispatchWinner(
  host: WorkerStartOptions,
  handles: LocalHandles,
  call: CallContext,
  decision: Extract<StartDecision, { kind: 'dispatch' }>,
): Promise<StartWorkerResult> {
  const current = await host.database.transaction(async (tx) => {
    const locked = await lockDispatch(tx, host, decision.claim.jobRunId);
    if (locked === undefined) return undefined;
    const deadline = locked.order.order.bootstrapDeadlineAt;
    return { ...locked, withinDeadline: hasOpenDeadline(deadline) };
  });
  if (current === undefined) return unresolved;
  if (current.claim.settled === null && current.order.state !== 'ordered')
    return settlePreRequestRejection(host, current.claim);
  const remaining = Date.parse(current.order.order.bootstrapDeadlineAt) - Date.now();
  if (current.claim.settled !== null || !current.withinDeadline || remaining <= 0)
    return observeDispatch(host, handles, call, { ...current, kind: 'observe' });
  const result = await boundedWait(sendProvision(host, handles, call, decision), remaining);
  return result.settled ? result.value : unresolved;
}

/**
 * Send outside the run transaction and supervise the returned allocation.
 * @param host - Composed host.
 * @param handles - Local handle ownership.
 * @param call - Authorized order owner.
 * @param decision - Winning dispatch and volatile material.
 * @returns The result of recording the sole sender's outcome.
 */
async function sendProvision(
  host: WorkerStartOptions,
  handles: LocalHandles,
  call: CallContext,
  decision: Extract<StartDecision, { kind: 'dispatch' }>,
): Promise<StartWorkerResult> {
  const { provider, material, claim } = decision;
  let request: OrderedProvisionRequest;
  try {
    host.operationSignal.throwIfAborted();
    request = { ...material, connection: host.connection() };
    host.operationSignal.throwIfAborted();
  } catch {
    return settlePreRequestRejection(host, claim);
  }
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
    return settlePreRequestRejection(host, claim, evidence.data);
  }
  if (outcome?.kind !== 'allocated') return settleWithoutAllocation(host, claim);
  return finishProvision(host, handles, call, claim, outcome);
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
 * Transfer a returned allocation to supervision or clean it up after closure or settlement.
 * @param host - Composed host.
 * @param handles - Local handle ownership.
 * @param call - Authorized order owner.
 * @param claim - Winning dispatch.
 * @param outcome - Allocation returned by the provider.
 * @returns The durable result.
 */
async function finishProvision(
  host: WorkerStartOptions,
  handles: LocalHandles,
  call: CallContext,
  claim: DispatchClaim,
  outcome: Extract<OrderedProvisionOutcome, { kind: 'allocated' }>,
): Promise<StartWorkerResult> {
  const { binding, jobRunId } = claim;
  const ref = parseReference(binding.providerId, outcome.allocationRef);
  const { handle } = outcome;
  const canTerminate = typeof handle?.terminate === 'function';
  const canRelease = typeof handle?.release === 'function';
  const bound =
    canTerminate && canRelease && typeof handle.cancel === 'function' && handle.executionId === jobRunId
      ? ref
      : undefined;
  const processBound = binding.allocationLifetime === 'provisioner-process-bound';
  const current = await recordSendSettled(host, claim, ref, bound).catch(async (error: unknown) => {
    if (processBound && canTerminate) {
      handles.set(jobRunId, handle);
    } else if (canRelease) {
      try {
        await handle.release();
      } catch {
        // The persistence error still determines the dispatch outcome.
      }
    }
    throw error;
  });
  if (processBound && !canTerminate) throw new TypeError('Process-bound worker handle requires terminate()');
  const result = current === undefined ? unresolved : resultOf(current.claim);
  if (current !== undefined && current.claim.settled !== null) {
    await finishLateAllocation(host, handles, call, current.claim, handle);
    return result;
  }
  if (processBound) handles.set(jobRunId, handle);
  try {
    if (current?.order.state === 'closed')
      return await observeDispatch(host, handles, call, { ...current, kind: 'observe' });
    // The provision call owns its local handle even if its run metadata is unusable for binding.
    if (processBound && bound === undefined) return finishProcessAllocation(host, handles, claim);
    return result;
  } finally {
    if (!processBound && canRelease) await handle.release().catch(() => undefined);
  }
}

/**
 * Record that the only send-capable invocation has settled and retain its candidate.
 * @param host - Composed host.
 * @param claim - Dispatch whose provider invocation settled.
 * @param ref - Valid candidate even if the returned handle cannot establish a binding.
 * @param bound - Candidate whose handle confirms the run identity.
 * @returns The persisted dispatch and the order snapshot read under the same lock.
 */
async function recordSendSettled(
  host: WorkerStartOptions,
  claim: DispatchClaim,
  ref?: ProviderAllocationRef,
  bound?: ProviderAllocationRef,
) {
  return host.database.transaction(async (tx) => {
    const current = await lockDispatch(tx, host, claim.jobRunId);
    if (current === undefined) return undefined;
    const previous = current.claim;
    if (previous.settled !== null) {
      if (ref === undefined) return current;
      const updated = await recordLateAllocation(tx, previous, { reference: ref, state: 'pending' });
      return { ...current, claim: updated };
    }
    const updated = await updateDispatch(tx, previous, {
      sendSettled: true,
      candidates: ref === undefined ? previous.candidates : mergeCandidates(previous.candidates, [ref]),
      boundAllocation: previous.boundAllocation ?? bound ?? null,
    });
    return { ...current, claim: updated };
  });
}

/**
 * Close the cleanup duty after the returned local handle confirms teardown.
 * @param host - Host owning the provider process.
 * @param handles - Local controls retained until teardown is recorded.
 * @param claim - Dispatch whose infrastructure is being torn down.
 * @returns The dispatch result supported by the recorded evidence.
 */
async function finishProcessAllocation(
  host: WorkerStartOptions,
  handles: LocalHandles,
  claim: DispatchClaim,
): Promise<StartWorkerResult> {
  const { jobRunId } = claim;
  const handle = handles.get(jobRunId);
  if (handle === undefined) return resultOf(claim);
  handles.delete(jobRunId);
  let result: StartWorkerResult;
  try {
    await handle.terminate();
    const settled = {
      source: 'worker-dispatch',
      summary: 'Process-bound allocation terminated',
      observedAt: new Date().toISOString(),
    };
    result = await host.database.transaction(async (tx) => {
      const current = await lockDispatch(tx, host, jobRunId);
      if (current === undefined) return unresolved;
      return resultOf(await updateDispatch(tx, current.claim, { settled }));
    });
  } catch (error) {
    handles.set(jobRunId, handle);
    throw error;
  }
  if (typeof handle.release === 'function') await handle.release().catch(() => undefined);
  return result;
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
    const boundAllocation =
      current.boundAllocation ??
      (locked.order.state !== 'closed' && proven !== undefined && proven > Date.now() && candidates.length === 1
        ? (observation.firstPageCandidate ?? null)
        : null);
    const absent = candidates.length === 0 && observation.seal?.refs.length === 0;
    const updated = await updateDispatch(tx, current, {
      candidates,
      boundAllocation,
      ...(absent ? { settled: observation.seal?.evidence } : {}),
    });
    const mayTerminate =
      locked.order.state === 'closed' &&
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
 * @param handles - Local process-bound control.
 * @param call - Current supervision call.
 * @param decision - Durable claim and locked run state.
 * @returns The available infrastructure evidence for the existing dispatch.
 */
export async function observeDispatch(
  host: WorkerStartOptions,
  handles: LocalHandles,
  call: CallContext,
  decision: Extract<StartDecision, { kind: 'observe' }>,
): Promise<StartWorkerResult> {
  const { claim, order } = decision;
  if (claim.settled !== null) {
    await finishLateAllocation(host, handles, call, claim);
    return resultOf(claim);
  }
  if (claim.binding.allocationLifetime === 'provisioner-process-bound') {
    if (order.state === 'closed' && claim.binding.processIncarnation === host.processIncarnation) {
      return finishProcessAllocation(host, handles, claim);
    }
    return resultOf(claim);
  }
  const provider = host.providers.get(claim.binding.providerId);
  if (provider?.allocationLifetime !== 'provider-managed') return unavailable;
  const observation = await observeManaged(
    call,
    provider.recovery,
    claim.binding,
    host.operationSignal,
    claim.sendSettled || !hasOpenDeadline(order.order.bootstrapDeadlineAt),
  );
  const candidates = mergeCandidates(claim.candidates, observation.candidates);
  const proven =
    order.state === 'closed' || claim.boundAllocation !== null
      ? undefined
      : await proveUniqueLive(
          call,
          provider.recovery,
          claim,
          candidates,
          observation.firstPageCandidate,
          host.operationSignal,
        );
  const recorded = await recordObservation(host, claim, observation, proven);
  if (recorded === undefined) return unresolved;
  const { updated, mayTerminate } = recorded;
  if (updated.settled !== null) return resultOf(updated);
  const result = resultOf(
    mayTerminate ? await cleanManaged(host, call, provider.recovery, updated, observation) : updated,
  );
  return result.kind === 'unknown' && result.reason === 'dispatch-unresolved' && !observation.observedPage
    ? unavailable
    : result;
}
