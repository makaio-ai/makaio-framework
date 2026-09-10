import {
  ExecutionAttemptControlReceiptSchema,
  ExecutionAttemptControlReportSchema,
  type ExecutionAttemptCancellationIntent,
  type ExecutionAttemptControlCorrelation,
  type ExecutionAttemptControlReceipt,
  type ExecutionAttemptControlReport,
  type ExecutionAttemptControlRefusalReason,
} from '@makaio/contracts';
import { canonicalStringify } from '@makaio/utils';
import type {
  AttemptControlState,
  ExecutionAttemptRecord,
  GetInstructionInput,
} from './execution-attempt-repository.js';

/** Separate immutable runtime facts for one accepted Cancel and addressed generation. */
export interface AttemptControlEvidence {
  readonly controlRevision: number;
  readonly runtimeGeneration: number;
  readonly receipt: ExecutionAttemptControlReceipt | null;
  readonly report: ExecutionAttemptControlReport | null;
}

/** Coherent recovery read; historical evidence never proves the current generation stopped. */
export interface AttemptCancellationControlState {
  readonly control: AttemptControlState;
  readonly cancellation: ExecutionAttemptCancellationIntent | null;
  readonly evidence: readonly AttemptControlEvidence[];
}

/** Exact Attempt and owner scope, without requiring the owner's current-attempt pointer. */
export type ReadAttemptCancellationControlInput = GetInstructionInput;

/** Store the actual runtime receipt, with owner identity supplied by the trusted caller. */
export interface RecordAttemptControlReceiptInput extends ExecutionAttemptControlReceipt {
  readonly executionId: string;
}

/** Store one final runtime conclusion, independently of receipt and terminal outcome. */
export interface ReportAttemptControlInput extends ExecutionAttemptControlReport {
  readonly executionId: string;
}

/** Exact duplicates preserve the first payload; refusals are not stop evidence. */
export type AttemptControlEvidenceDecision =
  | { readonly kind: 'accepted' | 'duplicate' }
  | { readonly kind: ExecutionAttemptControlRefusalReason };

/** Required atomic operations belonging to the existing Attempt authority. */
export interface AttemptControlEvidenceRepository {
  /**
   * Read intent, runtime correlation and all stored facts in one coherent snapshot.
   * @param input - Exact trusted owner and Attempt identity.
   * @returns Snapshot, or null when the Attempt does not belong to that owner.
   */
  readAttemptCancellationControl(
    input: ReadAttemptCancellationControlInput,
  ): Promise<AttemptCancellationControlState | null>;
  /**
   * Persist an actual delivery receipt without replacing a separately accepted report.
   * @param input - Runtime receipt plus trusted owner.
   * @returns Durable correlation/replay decision.
   */
  recordAttemptControlReceipt(input: RecordAttemptControlReceiptInput): Promise<AttemptControlEvidenceDecision>;
  /**
   * Persist a final scoped report without requiring a prior delivery ACK or current owner pointer.
   * @param input - Runtime observation plus trusted owner.
   * @returns Durable correlation/replay decision.
   */
  reportAttemptControl(input: ReportAttemptControlInput): Promise<AttemptControlEvidenceDecision>;
}

/**
 * Snapshot a trusted owner without normalizing its identity.
 * @param executionId - Owner supplied outside the wire payload.
 * @returns Validated owner identity.
 */
function requireOwner(executionId: string): string {
  if (typeof executionId !== 'string' || executionId.length === 0) {
    throw new TypeError('executionId must be a non-empty string');
  }
  return executionId;
}

/**
 * Detach the complete receipt before any asynchronous storage work.
 * @param input - Runtime receipt and trusted owner.
 * @returns Parsed snapshot.
 */
export function snapshotAttemptControlReceipt(
  input: RecordAttemptControlReceiptInput,
): RecordAttemptControlReceiptInput {
  const { executionId, ...receipt } = input;
  return { executionId: requireOwner(executionId), ...ExecutionAttemptControlReceiptSchema.parse(receipt) };
}

/**
 * Detach the complete final report before any asynchronous storage work.
 * @param input - Runtime observation and trusted owner.
 * @returns Parsed snapshot.
 */
export function snapshotAttemptControlReport(input: ReportAttemptControlInput): ReportAttemptControlInput {
  const { executionId, ...report } = input;
  return { executionId: requireOwner(executionId), ...ExecutionAttemptControlReportSchema.parse(report) };
}

/**
 * Check accepted-request and current runtime identity without consulting settlement or owner pointers.
 * @param attempt - Attempt row in the caller's transaction.
 * @param cancellation - Winning request from the same transaction.
 * @param input - Runtime correlation and trusted owner.
 * @returns Refusal, or null when the current runtime can add a new fact.
 */
function evaluateControlCorrelation(
  attempt: ExecutionAttemptRecord | null,
  cancellation: ExecutionAttemptCancellationIntent | null,
  input: ExecutionAttemptControlCorrelation & { readonly executionId: string },
): AttemptControlEvidenceDecision | null {
  if (attempt === null || attempt.executionId !== input.executionId) return { kind: 'not-found' };
  if (cancellation?.controlRevision !== input.controlRevision || cancellation.requestKey !== input.requestKey) {
    return { kind: 'cancel-mismatch' };
  }
  if (
    attempt.runtimeGeneration !== input.runtimeGeneration ||
    attempt.runtimeIncarnationId !== input.runtimeIncarnationId
  ) {
    return { kind: 'stale-generation' };
  }
  return null;
}

/**
 * Compare immutable wire facts, ignoring only the trusted owner wrapper.
 * @param stored - Original accepted fact for this request revision and runtime generation.
 * @param input - Candidate fact carrying the trusted owner.
 * @returns Exact duplicate or conflicting final content.
 */
function replayControlFact(
  stored: ExecutionAttemptControlReceipt | ExecutionAttemptControlReport,
  input: RecordAttemptControlReceiptInput | ReportAttemptControlInput,
): AttemptControlEvidenceDecision {
  const { executionId: _owner, ...fact } = input;
  return { kind: canonicalStringify(stored) === canonicalStringify(fact) ? 'duplicate' : 'conflict' };
}

/**
 * Accept a genuine receipt independently of operation occupancy and final reports.
 * @param attempt - Attempt row, or null when absent.
 * @param cancellation - Winning Cancel receipt.
 * @param stored - Previously persisted receipt for the candidate correlation.
 * @param input - Snapshotted received fact with trusted owner.
 * @returns Mutation decision; the repository owns the atomic write.
 */
export function evaluateAttemptControlReceipt(
  attempt: ExecutionAttemptRecord | null,
  cancellation: ExecutionAttemptCancellationIntent | null,
  stored: ExecutionAttemptControlReceipt | null,
  input: RecordAttemptControlReceiptInput,
): AttemptControlEvidenceDecision {
  if (attempt === null || attempt.executionId !== input.executionId) return { kind: 'not-found' };
  if (stored !== null) return replayControlFact(stored, input);
  return evaluateControlCorrelation(attempt, cancellation, input) ?? { kind: 'accepted' };
}

/**
 * Correlate the explicitly claimed boundary with admitted or completed Preparation facts.
 * This checks scope, not truth of the driver observation; no receipt implies global containment.
 * @param attempt - Coherent attempt with Preparation receipts.
 * @param input - Final scoped observation.
 * @returns Whether the named scope belongs to this runtime generation.
 */
function matchesControlOperation(attempt: ExecutionAttemptRecord, input: ReportAttemptControlInput): boolean {
  if (input.conclusion.boundary === 'admission-closed') {
    return (
      input.operationId === undefined &&
      attempt.operationStartGate === 'closed' &&
      (attempt.activeOperationId === null || attempt.activeOperationKind === 'runtime-probe')
    );
  }
  if (input.operationId === undefined) return false;
  const active =
    attempt.activeOperationId === input.operationId && attempt.activeOperationGeneration === input.runtimeGeneration;
  if (input.conclusion.boundary === 'setup-process-group') {
    return (
      (active && attempt.activeOperationKind === 'workspace-preparation') ||
      attempt.preparationReceipts.some(
        (receipt) => receipt.operationId === input.operationId && receipt.runtimeGeneration === input.runtimeGeneration,
      )
    );
  }
  return (
    active && (attempt.activeOperationKind === 'workload-invocation' || attempt.activeOperationKind === 'workflow-run')
  );
}

/**
 * Accept one final report, including negative findings and first reports after settlement.
 * @param attempt - Coherent attempt row including retained terminal operation and Preparation receipts.
 * @param cancellation - Winning Cancel receipt from the same transaction.
 * @param stored - Original final report for the candidate revision and generation.
 * @param input - Snapshotted runtime report with trusted owner.
 * @returns Mutation decision without altering admission, outcome, provider or Job state.
 */
export function evaluateAttemptControlReport(
  attempt: ExecutionAttemptRecord | null,
  cancellation: ExecutionAttemptCancellationIntent | null,
  stored: ExecutionAttemptControlReport | null,
  input: ReportAttemptControlInput,
): AttemptControlEvidenceDecision {
  if (attempt === null || attempt.executionId !== input.executionId) return { kind: 'not-found' };
  if (stored !== null) return replayControlFact(stored, input);
  const refusal = evaluateControlCorrelation(attempt, cancellation, input);
  if (refusal !== null) return refusal;
  return matchesControlOperation(attempt, input) ? { kind: 'accepted' } : { kind: 'operation-mismatch' };
}
