/**
 * Runtime and workflow-operation transitions for PostgreSQL execution attempts.
 *
 * This module keeps runtime fencing, operation admission, and preparation
 * receipts together because each transition guards the same attempt control
 * columns. The repository composes it with the transaction and row helpers.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ExecutionAttemptInstruction } from '@makaio/contracts';
import {
  evaluateOperationAdmission,
  evaluateOperationCompletion,
  evaluatePreparationReport,
  evaluateRuntimeReadiness,
  evaluateRuntimeRegistration,
  type AdmitOperationInput,
  type AttemptControlState,
  type CompleteOperationInput,
  type GetInstructionInput,
  type MarkRuntimeReadyInput,
  type OperationAdmissionDecision,
  type OperationCompletionDecision,
  type OperationReportDecision,
  type RegisterRuntimeInput,
  type ReportOperationInput,
  type RuntimeReadinessDecision,
  type RuntimeRegistrationDecision,
} from '@makaio/subsystem-workflow-engine';
import {
  decodeAttemptControlState,
  normalizeInstant,
  parseInstruction,
  parsePreparationReceipts,
  parsePreparationResult,
} from './execution-attempt-types.js';
import { toAttemptRecord, type ExecutionAttemptRows } from './execution-attempt-rows.js';
import {
  decideByWrite,
  isActiveAttemptRow,
  operationOwesTerminalConvergence,
  type ExecutionAttemptTransaction,
} from './execution-attempt-transaction.js';

/** Dependencies shared by the runtime method group. */
export interface ExecutionAttemptRuntimeContext {
  readonly transact: ExecutionAttemptTransaction['transact'];
  readonly decideByWrite: typeof decideByWrite;
  readonly readAttemptRow: ExecutionAttemptRows['readAttemptRow'];
  readonly readActiveAttemptId: ExecutionAttemptRows['readActiveAttemptId'];
  readonly allocationTerminated: ExecutionAttemptRows['allocationTerminated'];
  readonly runtimeReachability: ExecutionAttemptRows['runtimeReachability'];
}

/** Runtime/workflow-operation members of the execution-attempt repository. */
export interface ExecutionAttemptRuntimeMethods {
  readonly registerRuntime: (input: RegisterRuntimeInput) => Promise<RuntimeRegistrationDecision>;
  readonly admitOperation: (input: AdmitOperationInput) => Promise<OperationAdmissionDecision>;
  readonly getInstruction: (input: GetInstructionInput) => Promise<ExecutionAttemptInstruction | null>;
  readonly reportOperation: (input: ReportOperationInput) => Promise<OperationReportDecision>;
  readonly completeOperation: (input: CompleteOperationInput) => Promise<OperationCompletionDecision>;
  readonly markRuntimeReady: (input: MarkRuntimeReadyInput) => Promise<RuntimeReadinessDecision>;
  readonly getAttemptControlState: (executionAttemptId: string) => Promise<AttemptControlState | null>;
}

/**
 * Register a new runtime generation after validating reachability and fencing.
 * @param context - Transaction and row operations used for the transition.
 * @param input - Runtime registration request.
 * @returns The registration decision and allocated generation when registered.
 */
async function registerRuntime(
  context: ExecutionAttemptRuntimeContext,
  input: RegisterRuntimeInput,
): Promise<RuntimeRegistrationDecision> {
  return context.transact(async (session) => {
    let allocatedGeneration = 0;
    const decision = await context.decideByWrite<RuntimeRegistrationDecision | { readonly kind: 'applied' }>(
      async () => {
        const attemptRow = await context.readAttemptRow(session, input.executionAttemptId);
        if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
        const unreachable = await context.runtimeReachability(session, attemptRow);
        if (unreachable !== null) return unreachable;
        const control = decodeAttemptControlState(attemptRow);
        const refusal = evaluateRuntimeRegistration(control, input);
        if (refusal !== null) return refusal;

        allocatedGeneration = control.runtimeGeneration + 1;
        return () =>
          session.run(
            sql`UPDATE execution_attempt
                SET runtime_generation = ${allocatedGeneration},
                    runtime_incarnation_id = ${input.runtimeIncarnationId},
                    runtime_ready_at = NULL,
                    active_operation_id = NULL,
                    active_operation_kind = NULL,
                    active_operation_key = NULL,
                    active_operation_generation = NULL,
                    active_operation_admitted_at = NULL
                WHERE execution_attempt_id = ${input.executionAttemptId}
                  AND execution_id = ${input.executionId}
                  AND runtime_generation = ${control.runtimeGeneration}
                  AND settlement_kind IS NULL
                  AND (active_operation_id IS NULL OR active_operation_kind = ${'runtime-probe'})
                  AND allocation_ref IS NOT NULL
                  AND NOT ${operationOwesTerminalConvergence(input.executionAttemptId)}
                  AND ${isActiveAttemptRow()}`,
          );
      },
      { kind: 'applied' },
    );
    return decision.kind === 'applied' ? { kind: 'registered', runtimeGeneration: allocatedGeneration } : decision;
  });
}

/**
 * Admit a workflow operation after validating its runtime control state.
 * @param context - Transaction and row operations used for the transition.
 * @param input - Operation admission request.
 * @returns The admission decision and operation identity when admitted.
 */
async function admitOperation(
  context: ExecutionAttemptRuntimeContext,
  input: AdmitOperationInput,
): Promise<OperationAdmissionDecision> {
  const operationId = crypto.randomUUID();
  const admittedAt = normalizeInstant(new Date().toISOString());
  const readinessGuard: SQL = input.operationKind === 'runtime-probe' ? sql`1 = 1` : sql`runtime_ready_at IS NOT NULL`;
  return context.transact((session) =>
    context.decideByWrite<OperationAdmissionDecision>(
      async () => {
        const attemptRow = await context.readAttemptRow(session, input.executionAttemptId);
        if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
        const unreachable = await context.runtimeReachability(session, attemptRow);
        if (unreachable !== null) return unreachable;
        const control = decodeAttemptControlState(attemptRow);
        const refusal = evaluateOperationAdmission(control, input, admittedAt, toAttemptRecord(attemptRow));
        if (refusal !== null) return refusal;

        return () =>
          session.run(
            sql`UPDATE execution_attempt
                SET active_operation_id = ${operationId},
                    active_operation_kind = ${input.operationKind},
                    active_operation_key = ${input.admissionKey},
                    active_operation_generation = ${input.runtimeGeneration},
                    active_operation_admitted_at = ${admittedAt}
                WHERE execution_attempt_id = ${input.executionAttemptId}
                  AND execution_id = ${input.executionId}
                  AND active_operation_id IS NULL
                  AND operation_start_gate = ${'open'}
                  AND runtime_generation = ${input.runtimeGeneration}
                  AND instruction = ${attemptRow.instruction}
                  AND preparation_receipts = ${attemptRow.preparation_receipts}
                  AND settlement_kind IS NULL
                  AND allocation_ref IS NOT NULL
                  AND NOT ${operationOwesTerminalConvergence(input.executionAttemptId)}
                  AND ${readinessGuard}
                  AND ${isActiveAttemptRow()}`,
          );
      },
      { kind: 'admitted', operationId, runtimeGeneration: input.runtimeGeneration, admittedAt },
    ),
  );
}

/**
 * Read and parse the instruction for an execution attempt.
 * @param context - Transaction and row operations used for the read.
 * @param input - Execution and attempt identifiers to match.
 * @returns The parsed instruction, or null when the attempt does not match.
 */
async function getInstruction(
  context: ExecutionAttemptRuntimeContext,
  input: GetInstructionInput,
): Promise<ExecutionAttemptInstruction | null> {
  return context.transact(async (session) => {
    const row = await context.readAttemptRow(session, input.executionAttemptId);
    return row?.execution_id === input.executionId ? parseInstruction(JSON.parse(row.instruction)) : null;
  });
}

/**
 * Record a workspace-preparation result for the active operation.
 * @param context - Transaction and row operations used for the transition.
 * @param input - Preparation report to validate and persist.
 * @returns The report decision, including its accepted binding when applicable.
 */
async function reportOperation(
  context: ExecutionAttemptRuntimeContext,
  input: ReportOperationInput,
): Promise<OperationReportDecision> {
  const result = parsePreparationResult(input.result);
  return context.transact((session) =>
    context.decideByWrite<OperationReportDecision>(
      async () => {
        const row = await context.readAttemptRow(session, input.executionAttemptId);
        if (row === undefined || row.execution_id !== input.executionId) return { kind: 'not-found' };
        const attempt = toAttemptRecord(row);
        const refusal = evaluatePreparationReport(
          {
            matchesExecution: true,
            settled: row.settlement_kind !== null,
            active: (await context.readActiveAttemptId(session, input.executionId)) === input.executionAttemptId,
            allocated:
              row.allocation_ref !== null && !(await context.allocationTerminated(session, input.executionAttemptId)),
          },
          attempt,
          attempt,
          { ...input, result },
        );
        if (refusal !== null) return refusal;
        const preparationReceipts = parsePreparationReceipts([
          ...attempt.preparationReceipts,
          { operationId: input.operationId, runtimeGeneration: input.runtimeGeneration, result },
        ]);
        return () =>
          session.run(sql`UPDATE execution_attempt
            SET preparation_receipts = ${JSON.stringify(preparationReceipts)},
                active_operation_id = NULL,
                active_operation_kind = NULL,
                active_operation_key = NULL,
                active_operation_generation = NULL,
                active_operation_admitted_at = NULL,
                last_completed_operation_id = ${input.operationId}
            WHERE execution_attempt_id = ${input.executionAttemptId}
              AND execution_id = ${input.executionId}
              AND settlement_kind IS NULL
              AND runtime_generation = ${input.runtimeGeneration}
              AND active_operation_id = ${input.operationId}
              AND active_operation_kind = ${'workspace-preparation'}
              AND active_operation_generation = ${input.runtimeGeneration}
              AND instruction = ${row.instruction}
              AND preparation_receipts = ${row.preparation_receipts}
              AND allocation_ref IS NOT NULL
              AND NOT ${operationOwesTerminalConvergence(input.executionAttemptId)}
              AND ${isActiveAttemptRow()}`);
      },
      { kind: 'accepted', binding: result.binding },
    ),
  );
}

/**
 * Complete an active runtime-probe or workflow-run operation.
 * @param context - Transaction and row operations used for the transition.
 * @param input - Operation completion request.
 * @returns The completion decision.
 */
async function completeOperation(
  context: ExecutionAttemptRuntimeContext,
  input: CompleteOperationInput,
): Promise<OperationCompletionDecision> {
  return context.transact((session) =>
    context.decideByWrite<OperationCompletionDecision>(
      async () => {
        const attemptRow = await context.readAttemptRow(session, input.executionAttemptId);
        if (attemptRow === undefined) return { kind: 'not-found' };
        if (attemptRow.settlement_kind !== null) return { kind: 'resolved' };
        const control = decodeAttemptControlState(attemptRow);
        const refusal = evaluateOperationCompletion(control, input);
        if (refusal !== null) return refusal;

        return () =>
          session.run(
            sql`UPDATE execution_attempt
                SET active_operation_id = NULL,
                    active_operation_kind = NULL,
                    active_operation_key = NULL,
                    active_operation_generation = NULL,
                    active_operation_admitted_at = NULL,
                    last_completed_operation_id = ${input.operationId}
                WHERE execution_attempt_id = ${input.executionAttemptId}
                  AND settlement_kind IS NULL
                  AND active_operation_id = ${input.operationId}
                  AND active_operation_kind IN (${'runtime-probe'}, ${'workflow-run'})
                  AND active_operation_generation = ${input.runtimeGeneration}`,
          );
      },
      { kind: 'completed' },
    ),
  );
}

/**
 * Mark a registered runtime generation ready for non-probe operations.
 * @param context - Transaction and row operations used for the transition.
 * @param input - Runtime readiness request.
 * @returns The readiness decision and accepted instant when ready.
 */
async function markRuntimeReady(
  context: ExecutionAttemptRuntimeContext,
  input: MarkRuntimeReadyInput,
): Promise<RuntimeReadinessDecision> {
  const acceptedAt = normalizeInstant(input.readyAt);
  return context.transact((session) =>
    context.decideByWrite<RuntimeReadinessDecision>(
      async () => {
        const attemptRow = await context.readAttemptRow(session, input.executionAttemptId);
        if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
        const unreachable = await context.runtimeReachability(session, attemptRow);
        if (unreachable !== null) return unreachable;
        const control = decodeAttemptControlState(attemptRow);
        const refusal = evaluateRuntimeReadiness(control, input);
        if (refusal !== null) return refusal;

        return () =>
          session.run(
            sql`UPDATE execution_attempt SET runtime_ready_at = ${acceptedAt}
                WHERE execution_attempt_id = ${input.executionAttemptId}
                  AND execution_id = ${input.executionId}
                  AND settlement_kind IS NULL
                  AND runtime_generation = ${input.runtimeGeneration}
                  AND runtime_ready_at IS NULL
                  AND active_operation_id IS NULL
                  AND allocation_ref IS NOT NULL
                  AND NOT ${operationOwesTerminalConvergence(input.executionAttemptId)}
                  AND ${isActiveAttemptRow()}`,
          );
      },
      { kind: 'ready', acceptedAt },
    ),
  );
}

/**
 * Read the current control state for an execution attempt.
 * @param context - Transaction and row operations used for the read.
 * @param executionAttemptId - Identifier of the execution attempt.
 * @returns The decoded control state, or null when the attempt does not exist.
 */
async function getAttemptControlState(
  context: ExecutionAttemptRuntimeContext,
  executionAttemptId: string,
): Promise<AttemptControlState | null> {
  return context.transact(async (session) => {
    const row = await context.readAttemptRow(session, executionAttemptId);
    return row === undefined ? null : decodeAttemptControlState(row);
  });
}

/**
 * Create the runtime and workflow-operation repository methods.
 * @param context - Transaction and row operations shared by runtime transitions.
 * @returns Runtime and workflow-operation repository methods.
 */
export function createRuntimeMethods(context: ExecutionAttemptRuntimeContext): ExecutionAttemptRuntimeMethods {
  return {
    registerRuntime: (input) => registerRuntime(context, input),
    admitOperation: (input) => admitOperation(context, input),
    getInstruction: (input) => getInstruction(context, input),
    reportOperation: (input) => reportOperation(context, input),
    completeOperation: (input) => completeOperation(context, input),
    markRuntimeReady: (input) => markRuntimeReady(context, input),
    getAttemptControlState: (executionAttemptId) => getAttemptControlState(context, executionAttemptId),
  };
}
