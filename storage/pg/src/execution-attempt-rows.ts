/**
 * Session-local row access for the PostgreSQL execution-attempt repository.
 * @internal
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ExecutionAttemptControlReceiptSchema, ExecutionAttemptControlReportSchema } from '@makaio/contracts';
import type { RawSqlSession } from '@makaio/storage-drizzle';
import { evaluateAttemptReachability, isProviderOperationResolved } from '@makaio/subsystem-workflow-engine';
import type {
  AttemptControlEvidence,
  AttemptReachabilityDecision,
  ExecutionAttemptCancellationIntent,
  ExecutionAttemptRecord,
  ProviderOperationClaim,
} from '@makaio/subsystem-workflow-engine';
import { toAttemptRecord, toOperationRecord, type AttemptRow, type OperationRow } from './execution-attempt-types.js';

export { toAttemptRecord, toOperationRecord, type AttemptRow, type OperationRow } from './execution-attempt-types.js';

interface ActiveAttemptRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
}

export type ClaimAuthorization =
  | {
      readonly kind: 'authorized';
      readonly attempt: ExecutionAttemptRecord;
      readonly attemptRow: AttemptRow;
      readonly operation: OperationRow;
    }
  | { readonly kind: 'stale'; readonly attempt: ExecutionAttemptRecord }
  | { readonly kind: 'resolved'; readonly attempt: ExecutionAttemptRecord }
  | { readonly kind: 'not-found' };

export type ClaimRefusal = { readonly kind: 'stale' | 'resolved' | 'not-found' };

export interface ExecutionAttemptRows {
  readonly readCancellationInSession: (
    session: RawSqlSession,
    executionAttemptId: string,
  ) => Promise<ExecutionAttemptCancellationIntent | null>;
  readonly readControlEvidenceInSession: (
    session: RawSqlSession,
    executionAttemptId: string,
  ) => Promise<AttemptControlEvidence[]>;
  readonly writeCancellationInSession: (
    session: RawSqlSession,
    executionAttemptId: string,
    intent: ExecutionAttemptCancellationIntent,
  ) => Promise<void>;
  readonly readAttemptRow: (session: RawSqlSession, executionAttemptId: string) => Promise<AttemptRow | undefined>;
  readonly readOperationRow: (session: RawSqlSession, executionAttemptId: string) => Promise<OperationRow | undefined>;
  readonly allocationTerminated: (session: RawSqlSession, executionAttemptId: string) => Promise<boolean>;
  readonly readActiveAttemptId: (session: RawSqlSession, executionId: string) => Promise<string | null>;
  readonly runtimeReachability: (
    session: RawSqlSession,
    row: AttemptRow,
  ) => Promise<AttemptReachabilityDecision | null>;
  readonly authorize: (session: RawSqlSession, claim: ProviderOperationClaim) => Promise<ClaimAuthorization>;
  readonly refuseUnauthorized: (
    session: RawSqlSession,
    claim: ProviderOperationClaim,
  ) => Promise<ClaimRefusal | undefined>;
}

const cancellationReceiptSchema = z.object({
  requestKey: z.string().min(1),
  controlRevision: z.number().int().positive(),
  requestedAt: z.string().datetime(),
  reason: z.string().optional(),
});

interface ExecutionAttemptRowsContext {
  readonly lockOwner: (session: RawSqlSession, executionId: string) => Promise<void>;
}

/**
 * Read the persisted cancellation intent for an execution attempt.
 * @param session - Session used to read the cancellation row.
 * @param executionAttemptId - Identifier of the execution attempt.
 * @returns The parsed cancellation intent, or null when none was requested.
 */
async function readCancellationInSession(
  session: RawSqlSession,
  executionAttemptId: string,
): Promise<ExecutionAttemptCancellationIntent | null> {
  const [row] = await session.all<{
    request_key: string;
    control_revision: number;
    requested_at: string;
    reason: string | null;
  }>(
    sql`SELECT request_key, control_revision, requested_at, reason
      FROM execution_attempt_cancellation WHERE execution_attempt_id = ${executionAttemptId}`,
  );
  return row === undefined
    ? null
    : cancellationReceiptSchema.parse({
        requestKey: row.request_key,
        controlRevision: row.control_revision,
        requestedAt: row.requested_at,
        ...(row.reason === null ? {} : { reason: row.reason }),
      });
}

/**
 * Read control receipts and reports recorded for an execution attempt.
 * @param session - Session used to read the evidence rows.
 * @param executionAttemptId - Identifier of the execution attempt.
 * @returns Control evidence ordered by control revision and runtime generation.
 */
async function readControlEvidenceInSession(
  session: RawSqlSession,
  executionAttemptId: string,
): Promise<AttemptControlEvidence[]> {
  const rows = await session.all<{
    control_revision: number;
    runtime_generation: number;
    receipt_json: string | null;
    report_json: string | null;
  }>(sql`SELECT control_revision, runtime_generation, receipt_json, report_json
    FROM execution_attempt_control_evidence WHERE execution_attempt_id = ${executionAttemptId}
    ORDER BY control_revision, runtime_generation`);
  return rows.map((row) => ({
    controlRevision: row.control_revision,
    runtimeGeneration: row.runtime_generation,
    receipt:
      row.receipt_json === null ? null : ExecutionAttemptControlReceiptSchema.parse(JSON.parse(row.receipt_json)),
    report: row.report_json === null ? null : ExecutionAttemptControlReportSchema.parse(JSON.parse(row.report_json)),
  }));
}

/**
 * Persist a cancellation intent and close the attempt's operation start gate.
 * @param session - Session used to write the cancellation state.
 * @param executionAttemptId - Identifier of the execution attempt.
 * @param intent - Cancellation intent to persist.
 * @returns A promise that resolves after both writes complete.
 */
async function writeCancellationInSession(
  session: RawSqlSession,
  executionAttemptId: string,
  intent: ExecutionAttemptCancellationIntent,
): Promise<void> {
  await session.run(sql`INSERT INTO execution_attempt_cancellation
    (execution_attempt_id, request_key, control_revision, requested_at, reason)
    VALUES (${executionAttemptId}, ${intent.requestKey}, ${intent.controlRevision},
      ${intent.requestedAt}, ${intent.reason ?? null})`);
  await session.run(sql`UPDATE execution_attempt SET operation_start_gate = 'closed'
    WHERE execution_attempt_id = ${executionAttemptId}`);
}

/**
 * Read an attempt row after acquiring its execution owner's lock.
 * @param context - Owner-lock operation required before the final read.
 * @param session - Session used to read and lock the attempt.
 * @param executionAttemptId - Identifier of the execution attempt.
 * @returns The locked attempt row, or undefined when it does not exist.
 */
async function readAttemptRow(
  context: ExecutionAttemptRowsContext,
  session: RawSqlSession,
  executionAttemptId: string,
): Promise<AttemptRow | undefined> {
  const [initial] = await session.all<AttemptRow>(
    sql`SELECT * FROM execution_attempt WHERE execution_attempt_id = ${executionAttemptId}`,
  );
  if (initial === undefined) return undefined;
  await context.lockOwner(session, initial.execution_id);
  return (
    await session.all<AttemptRow>(
      sql`SELECT * FROM execution_attempt WHERE execution_attempt_id = ${executionAttemptId}`,
    )
  )[0];
}

/**
 * Read the provider operation row belonging to an execution attempt.
 * @param session - Session used to read the provider operation.
 * @param executionAttemptId - Identifier of the execution attempt.
 * @returns The provider operation row, or undefined when it does not exist.
 */
async function readOperationRow(session: RawSqlSession, executionAttemptId: string): Promise<OperationRow | undefined> {
  return (
    await session.all<OperationRow>(
      sql`SELECT * FROM provider_operation WHERE execution_attempt_id = ${executionAttemptId}`,
    )
  )[0];
}

/**
 * Determine whether an attempt allocation owes terminal convergence.
 * @param session - Session used to read the provider operation.
 * @param executionAttemptId - Identifier of the execution attempt.
 * @returns True when the operation has the terminal-convergence obligation.
 */
async function allocationTerminated(session: RawSqlSession, executionAttemptId: string): Promise<boolean> {
  return (await readOperationRow(session, executionAttemptId))?.obligation === 'terminal-convergence';
}

/**
 * Read the active attempt identifier for an execution.
 * @param session - Session used to read the active-attempt projection.
 * @param executionId - Identifier of the execution.
 * @returns The active attempt identifier, or null when no attempt is active.
 */
async function readActiveAttemptId(session: RawSqlSession, executionId: string): Promise<string | null> {
  return (
    (
      await session.all<ActiveAttemptRow>(
        sql`SELECT execution_attempt_id FROM active_execution_attempt WHERE execution_id = ${executionId}`,
      )
    )[0]?.execution_attempt_id ?? null
  );
}

/**
 * Evaluate whether the supplied attempt remains reachable at runtime.
 * @param session - Session used to resolve active allocation state.
 * @param row - Persisted attempt row to evaluate.
 * @returns A refusal decision, or null when the attempt is reachable.
 */
async function runtimeReachability(
  session: RawSqlSession,
  row: AttemptRow,
): Promise<AttemptReachabilityDecision | null> {
  const settled = row.settlement_kind !== null;
  const active = !settled && (await readActiveAttemptId(session, row.execution_id)) === row.execution_attempt_id;
  return evaluateAttemptReachability({
    matchesExecution: true,
    settled,
    active,
    allocated:
      active && row.allocation_ref !== null && !(await allocationTerminated(session, row.execution_attempt_id)),
  });
}

/**
 * Authorize a provider-operation claim against the locked attempt state.
 * @param context - Owner-lock operation required to read the attempt.
 * @param session - Session used to read the claim state.
 * @param claim - Provider-operation claim to authorize.
 * @returns Authorization details or the reason the claim cannot proceed.
 */
async function authorize(
  context: ExecutionAttemptRowsContext,
  session: RawSqlSession,
  claim: ProviderOperationClaim,
): Promise<ClaimAuthorization> {
  const attemptRow = await readAttemptRow(context, session, claim.executionAttemptId);
  const operation = await readOperationRow(session, claim.executionAttemptId);
  if (attemptRow === undefined || operation === undefined) return { kind: 'not-found' };
  const attempt = toAttemptRecord(attemptRow);
  if (isProviderOperationResolved(attempt, toOperationRecord(operation))) return { kind: 'resolved', attempt };
  if (
    operation.token === null ||
    operation.token !== claim.token ||
    operation.generation !== claim.generation ||
    operation.owner_id !== claim.ownerId
  ) {
    return { kind: 'stale', attempt };
  }
  return { kind: 'authorized', attempt, attemptRow, operation };
}

/**
 * Convert a non-authorized provider-operation claim into a refusal.
 * @param context - Owner-lock operation required to read the attempt.
 * @param session - Session used to read the claim state.
 * @param claim - Provider-operation claim to refuse when unauthorized.
 * @returns A refusal, or undefined when the claim is authorized.
 */
async function refuseUnauthorized(
  context: ExecutionAttemptRowsContext,
  session: RawSqlSession,
  claim: ProviderOperationClaim,
): Promise<ClaimRefusal | undefined> {
  const authorization = await authorize(context, session, claim);
  return authorization.kind === 'authorized' ? undefined : { kind: authorization.kind };
}

/**
 * Create row operations bound to the transaction's execution-owner lock.
 * @param context - Owner-lock operation shared by all row reads.
 * @returns Session-local attempt, operation, and control-evidence accessors.
 */
export function createExecutionAttemptRows(context: ExecutionAttemptRowsContext): ExecutionAttemptRows {
  return {
    readCancellationInSession,
    readControlEvidenceInSession,
    writeCancellationInSession,
    readAttemptRow: (session, executionAttemptId) => readAttemptRow(context, session, executionAttemptId),
    readOperationRow,
    allocationTerminated,
    readActiveAttemptId,
    runtimeReachability,
    authorize: (session, claim) => authorize(context, session, claim),
    refuseUnauthorized: (session, claim) => refuseUnauthorized(context, session, claim),
  };
}
