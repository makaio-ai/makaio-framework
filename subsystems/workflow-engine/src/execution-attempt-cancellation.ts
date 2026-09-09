import type { ExecutionOwnerId } from './execution-attempt-repository.js';

/** A durable request to stop an attempt, never evidence that it stopped. */
export interface ExecutionAttemptCancellationIntent {
  /** Winning owner request key, scoped to this attempt and retained for replay. */
  readonly requestKey: string;
  /** Accepted control-request revision; delivery and runtime reports never advance it. */
  readonly controlRevision: number;
  /** First accepted request time, preserved across duplicate requests and controller handoff. */
  readonly requestedAt: string;
  /** Optional owner-supplied explanation. */
  readonly reason?: string;
}

/** Owner-scoped cancellation of attempts that exist when the request commits. */
export interface RequestExecutionCancellationInput {
  /** Owner authorizing the cancellation of its existing attempts. */
  readonly executionId: ExecutionOwnerId;
  /** Explanation retained only when this is the first request for an attempt. */
  readonly reason?: string;
}

/** Trusted owner authorization to stop one exact attempt, including historical cleanup. */
export interface RequestAttemptCancellationInput extends RequestExecutionCancellationInput {
  readonly executionAttemptId: string;
  /** Non-empty correlation key retained by the owner across retries. */
  readonly requestKey: string;
}

/** A winning request is durable intent, never evidence that work or its allocation stopped. */
export type ExecutionAttemptCancellationDecision =
  | { readonly kind: 'accepted' | 'replayed'; readonly intent: ExecutionAttemptCancellationIntent }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' };

/** Accepted control requests observed atomically with the first canonical outcome commit. */
export interface AttemptOutcomeControlObservation {
  /** Zero before Cancel; the winning request revision afterwards. */
  readonly controlRevision: number;
  /** A detached winning receipt, or null when no Cancel had been accepted. */
  readonly cancellation: ExecutionAttemptCancellationIntent | null;
}

/**
 * Require an opaque identity without normalizing its scope.
 * @param value - Supplied owner, attempt or request identity.
 * @param name - Member named in an invalid-input error.
 */
function requireCancellationIdentity(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/**
 * Snapshot an owner-wide request before asynchronous storage work.
 * @param input - Trusted owner identity and optional explanation.
 * @returns Validated scalar fields without caller-owned references.
 */
export function snapshotRequestExecutionCancellationInput(
  input: RequestExecutionCancellationInput,
): RequestExecutionCancellationInput {
  const { executionId, reason } = input;
  requireCancellationIdentity(executionId, 'executionId');
  if (reason !== undefined && typeof reason !== 'string') {
    throw new TypeError('reason must be a string when provided');
  }
  return { executionId, ...(reason === undefined ? {} : { reason }) };
}

/**
 * Snapshot exact cancellation scope and correlation before the first await.
 * @param input - Trusted owner, exact attempt, request identity and reason.
 * @returns Validated scalar request without normalizing identities or explanations.
 */
export function snapshotRequestAttemptCancellationInput(
  input: RequestAttemptCancellationInput,
): RequestAttemptCancellationInput {
  const { executionAttemptId, requestKey } = input;
  requireCancellationIdentity(executionAttemptId, 'executionAttemptId');
  requireCancellationIdentity(requestKey, 'requestKey');
  return { ...snapshotRequestExecutionCancellationInput(input), executionAttemptId, requestKey };
}

/**
 * Decide winning-request semantics after the store has established exact owner membership.
 * The store supplies one commit instant and owns atomic receipt/gate mutation. This helper
 * neither checks runtime reachability nor treats a settled attempt as immune to cleanup.
 * Losing keys are no-op requests, not accepted commands requiring a command-history log.
 * @param stored - Coherently read winning receipt, or null before cancellation.
 * @param input - Validated candidate key and explanation.
 * @param requestedAt - Store-generated first-acceptance instant, ignored for replay/conflict.
 * @returns First winner or immutable replay, or conflicting reuse of the winning key.
 */
export function evaluateAttemptCancellation(
  stored: ExecutionAttemptCancellationIntent | null,
  input: Pick<RequestAttemptCancellationInput, 'requestKey' | 'reason'>,
  requestedAt: string,
): Exclude<ExecutionAttemptCancellationDecision, { readonly kind: 'not-found' }> {
  if (stored !== null) {
    if (stored.requestKey === input.requestKey && stored.reason !== input.reason) {
      return { kind: 'conflict' };
    }
    return { kind: 'replayed', intent: { ...stored } };
  }
  return {
    kind: 'accepted',
    intent: {
      requestKey: input.requestKey,
      controlRevision: 1,
      requestedAt,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
  };
}

/**
 * Capture accepted control facts alongside a fresh canonical outcome in its transaction.
 * An absent Cancel is known revision zero, unlike a legacy outcome's unknown observation.
 * @param cancellation - Winning request read in the same transaction as the outcome write.
 * @returns Detached control facts that subsequent cancellation cannot rewrite.
 */
export function snapshotAttemptOutcomeControl(
  cancellation: ExecutionAttemptCancellationIntent | null,
): AttemptOutcomeControlObservation {
  return {
    controlRevision: cancellation?.controlRevision ?? 0,
    cancellation: cancellation === null ? null : { ...cancellation },
  };
}
