import type {
  AdmitOperationInput,
  AttemptControlState,
  CompleteOperationInput,
  MarkRuntimeReadyInput,
  OperationAdmissionDecision,
  OperationCompletionDecision,
  RegisterRuntimeInput,
  RuntimeReadinessDecision,
  RuntimeRegistrationDecision,
} from './execution-attempt-repository.js';

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
 * Evaluate admission after reachability: replay, busy, gate, readiness, then generation.
 * Probe operations are admitted before readiness because they establish that proof.
 * @param control - Current decoded control state, not modified by this function.
 * @param input - Operation admission being considered.
 * @param fallbackAdmittedAt - Realization-supplied instant for a duplicate missing its stored instant.
 * @returns A non-write decision, or null to attempt the realization's guarded admission.
 */
export function evaluateOperationAdmission(
  control: AttemptControlState,
  input: AdmitOperationInput,
  fallbackAdmittedAt: string,
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
