import { canonicalStringify } from '@makaio/utils';
import type {
  AdmitOperationInput,
  AttemptControlState,
  AttemptExecutionState,
  CompleteOperationInput,
  ExecutionAttemptRecord,
  MarkRuntimeReadyInput,
  OperationAdmissionDecision,
  OperationCompletionDecision,
  OperationReportDecision,
  ProvisionerIncarnationLossDecision,
  RecordProvisionerIncarnationLostInput,
  RegisterRuntimeInput,
  ReportOperationInput,
  RuntimeReadinessDecision,
  RuntimeRegistrationDecision,
} from './execution-attempt-repository.js';

/** Runtime and operation expected to remain current when an outcome becomes durable. */
export interface RuntimeOutcomeFence {
  /** Registered runtime generation that produced the result. */
  readonly runtimeGeneration: number;
  /** Admitted operation, or null for a startup failure before any operation. */
  readonly operationId: string | null;
}

/** A runtime result lost its execution slot before commit; the attempt remains available to its current runtime. */
export class RuntimeOutcomeFenceMismatchError extends Error {
  public constructor() {
    super('Runtime outcome no longer matches the current generation and operation');
    this.name = 'RuntimeOutcomeFenceMismatchError';
  }
}

/**
 * Require a fresh runtime outcome to belong to the coherently read execution slot.
 * Repositories call this after canonical replay/settlement decisions and repeat its
 * predicates in the committing write. A mismatch must not settle the attempt's waiter.
 * @param control - Current runtime and operation facts.
 * @param fence - Expected runtime slot, absent for owner-only outcome submission.
 * @throws RuntimeOutcomeFenceMismatchError when the originating runtime slot changed.
 */
export function assertRuntimeOutcomeFence(control: AttemptControlState, fence: RuntimeOutcomeFence | undefined): void {
  if (fence === undefined) return;
  if (
    control.runtimeGeneration !== fence.runtimeGeneration ||
    control.activeOperationId !== fence.operationId ||
    (fence.operationId !== null && control.activeOperationGeneration !== fence.runtimeGeneration)
  ) {
    throw new RuntimeOutcomeFenceMismatchError();
  }
}

/** Facts read coherently by a realization before decoding runtime control state. */
export interface AttemptReachability {
  /** Whether the requested attempt exists and belongs to the requested owner. */
  readonly matchesExecution: boolean;
  /** Whether the attempt has a terminal settlement. */
  readonly settled: boolean;
  /** Whether this is still the owner's active attempt. */
  readonly active: boolean;
  /** Whether an allocation exists and is not durably terminated. */
  readonly allocated: boolean;
}

/** Refusals shared by registration, admission, and readiness, before control decoding. */
export type AttemptReachabilityDecision = Extract<
  RuntimeRegistrationDecision,
  { readonly kind: 'not-found' | 'resolved' | 'fenced' | 'not-allocated' }
>;

/**
 * Evaluate the common reachability precedence without reading or mutating storage.
 * A null result only permits further evaluation; it never authorizes an unguarded write.
 * @param facts - Coherent lifecycle, owner, and allocation facts supplied by the realization.
 * @returns The first refusal, or null when runtime control may be decoded and evaluated.
 */
export function evaluateAttemptReachability(facts: AttemptReachability): AttemptReachabilityDecision | null {
  if (!facts.matchesExecution) return { kind: 'not-found' };
  if (facts.settled) return { kind: 'resolved' };
  if (!facts.active) return { kind: 'fenced' };
  if (!facts.allocated) return { kind: 'not-allocated' };
  return null;
}

/**
 * Evaluate process-loss applicability after evidence parsing and claim authorization.
 * Owner, lifetime, and incarnation refusals precede a recorded allocation.
 * A null result permits only the realization's existing guarded settlement.
 * @param attempt - Coherently read immutable provider binding and allocation facts.
 * @param input - Owner identity and process-loss proof whose evidence the realization already parsed.
 * @returns The first applicability refusal, or null to attempt the guarded write.
 */
export function evaluateProvisionerIncarnationLoss(
  attempt: Pick<
    ExecutionAttemptRecord,
    'executionId' | 'allocationLifetime' | 'provisionerIncarnationId' | 'allocationRef'
  >,
  input: Pick<RecordProvisionerIncarnationLostInput, 'executionId' | 'proof'>,
): Extract<
  ProvisionerIncarnationLossDecision,
  { readonly kind: 'not-found' | 'not-process-bound' | 'incarnation-mismatch' | 'allocated' }
> | null {
  if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
  if (attempt.allocationLifetime !== 'provisioner-process-bound') {
    return { kind: 'not-process-bound', allocationLifetime: attempt.allocationLifetime };
  }
  if (
    attempt.provisionerIncarnationId === null ||
    attempt.provisionerIncarnationId !== input.proof.provisionerIncarnationId
  ) {
    return { kind: 'incarnation-mismatch', provisionerIncarnationId: attempt.provisionerIncarnationId };
  }
  if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };
  return null;
}

/**
 * Evaluate registration after reachability, preserving replay before busy refusal.
 * An orphaned runtime probe may be reclaimed; a workload operation may not.
 * @param control - Current decoded control state, not modified by this function.
 * @param input - Runtime registration being considered.
 * @returns A non-write decision, or null to attempt the realization's guarded registration.
 */
export function evaluateRuntimeRegistration(
  control: AttemptControlState,
  input: RegisterRuntimeInput,
): Exclude<RuntimeRegistrationDecision, { readonly kind: 'registered' }> | null {
  if (control.runtimeIncarnationId === input.runtimeIncarnationId) {
    return {
      kind: 'duplicate',
      runtimeGeneration: control.runtimeGeneration,
      runtimeReadyAt: control.runtimeReadyAt,
    };
  }
  if (control.activeOperationId !== null && control.activeOperationKind !== 'runtime-probe') {
    return { kind: 'operation-active', operationId: control.activeOperationId };
  }
  return null;
}

/**
 * Evaluate admission after reachability: replay, busy, gate, readiness, generation, then Preparation.
 * Probe operations are admitted before readiness because they establish that proof.
 * @param control - Current decoded control state, not modified by this function.
 * @param input - Operation admission being considered.
 * @param fallbackAdmittedAt - Realization-supplied instant for a duplicate missing its stored instant.
 * @param execution - Frozen assignment and Preparation receipts read with the control state.
 * @returns A non-write decision, or null to attempt the realization's guarded admission.
 */
export function evaluateOperationAdmission(
  control: AttemptControlState,
  input: AdmitOperationInput,
  fallbackAdmittedAt: string,
  execution: AttemptExecutionState,
): Exclude<OperationAdmissionDecision, { readonly kind: 'admitted' }> | null {
  if (control.activeOperationId !== null) {
    return control.activeOperationKey === input.admissionKey
      ? {
          kind: 'duplicate',
          operationId: control.activeOperationId,
          runtimeGeneration: control.activeOperationGeneration ?? control.runtimeGeneration,
          admittedAt: control.activeOperationAdmittedAt ?? fallbackAdmittedAt,
        }
      : { kind: 'operation-active', operationId: control.activeOperationId };
  }
  if (control.operationStartGate === 'closed') return { kind: 'gate-closed' };
  if (input.operationKind !== 'runtime-probe' && control.runtimeReadyAt === null) return { kind: 'not-ready' };
  if (control.runtimeGeneration !== input.runtimeGeneration) {
    return { kind: 'stale-generation', runtimeGeneration: control.runtimeGeneration };
  }
  const requiresPreparation = execution.instruction.workspace !== undefined;
  const prepared = execution.preparationReceipts.some(
    (receipt) => receipt.runtimeGeneration === control.runtimeGeneration,
  );
  if (input.operationKind === 'workspace-preparation') {
    if (!requiresPreparation) return { kind: 'preparation-not-required' };
    if (prepared) return { kind: 'preparation-already-completed' };
  }
  // The retained workflow adapter operation cannot bypass generic Preparation.
  if (
    (input.operationKind === 'workload-invocation' || input.operationKind === 'workflow-run') &&
    requiresPreparation &&
    !prepared
  ) {
    return { kind: 'preparation-required' };
  }
  return null;
}

/**
 * Evaluate successful Preparation, retaining historical replay before current-runtime fences.
 * A null decision permits only a guarded write that saves the receipt and frees the slot together.
 * @param reachability - Coherent owner, allocation and lifecycle facts.
 * @param control - Current operation and runtime state.
 * @param execution - Frozen instruction and retained Preparation history.
 * @param input - Owner-scoped successful Preparation report.
 * @returns A historical duplicate or refusal, or null to atomically accept the result.
 */
export function evaluatePreparationReport(
  reachability: AttemptReachability,
  control: AttemptControlState,
  execution: AttemptExecutionState,
  input: ReportOperationInput,
): Exclude<OperationReportDecision, { readonly kind: 'accepted' }> | null {
  if (!reachability.matchesExecution) return { kind: 'not-found' };
  const previous = execution.preparationReceipts.find((receipt) => receipt.operationId === input.operationId);
  if (previous !== undefined) {
    return previous.runtimeGeneration === input.runtimeGeneration &&
      canonicalStringify(previous.result) === canonicalStringify(input.result)
      ? { kind: 'duplicate', binding: previous.result.binding }
      : { kind: 'conflict' };
  }
  const unreachable = evaluateAttemptReachability(reachability);
  if (unreachable !== null) return unreachable;
  if (control.runtimeGeneration !== input.runtimeGeneration) return { kind: 'stale-generation' };
  if (control.activeOperationId === null) return { kind: 'no-active-operation' };
  if (control.activeOperationId !== input.operationId || control.activeOperationKind !== 'workspace-preparation') {
    return { kind: 'operation-mismatch' };
  }
  if (control.activeOperationGeneration !== input.runtimeGeneration) return { kind: 'stale-generation' };
  const workspace = execution.instruction.workspace;
  if (workspace === undefined) return { kind: 'preparation-not-required' };
  const requestedIds = workspace.sourceRoots.map((root) => root.id).sort();
  const reportedIds = input.result.binding.sourceRoots.map((root) => root.id).sort();
  if (canonicalStringify(requestedIds) !== canonicalStringify(reportedIds)) return { kind: 'binding-mismatch' };
  return null;
}

/**
 * Evaluate completion after presence and settlement checks, without owner or allocation fences.
 * A replay is recognized even after its active slot has been cleared or reused.
 * @param control - Current decoded control state, not modified by this function.
 * @param input - Operation completion being considered.
 * @returns A non-write decision, or null to attempt the realization's guarded completion.
 */
export function evaluateOperationCompletion(
  control: AttemptControlState,
  input: CompleteOperationInput,
): Exclude<OperationCompletionDecision, { readonly kind: 'completed' }> | null {
  if (control.lastCompletedOperationId === input.operationId) return { kind: 'duplicate' };
  if (control.activeOperationId === null) return { kind: 'not-active' };
  if (control.activeOperationId !== input.operationId) {
    return { kind: 'mismatch', activeOperationId: control.activeOperationId };
  }
  if (control.activeOperationGeneration !== input.runtimeGeneration) return { kind: 'stale-generation' };
  if (
    control.activeOperationKind === 'workspace-preparation' ||
    control.activeOperationKind === 'workload-invocation'
  ) {
    return { kind: 'result-required' };
  }
  return null;
}

/**
 * Evaluate readiness after reachability: generation fence, replay, then busy refusal.
 * @param control - Current decoded control state, not modified by this function.
 * @param input - Runtime readiness report being considered.
 * @returns A non-write decision, or null to attempt the realization's guarded readiness write.
 */
export function evaluateRuntimeReadiness(
  control: AttemptControlState,
  input: MarkRuntimeReadyInput,
): Exclude<RuntimeReadinessDecision, { readonly kind: 'ready' }> | null {
  if (control.runtimeGeneration !== input.runtimeGeneration) return { kind: 'stale-generation' };
  if (control.runtimeReadyAt !== null) return { kind: 'duplicate', acceptedAt: control.runtimeReadyAt };
  if (control.activeOperationId !== null) {
    return { kind: 'operation-active', operationId: control.activeOperationId };
  }
  return null;
}
