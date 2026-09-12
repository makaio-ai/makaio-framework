/**
 * Cancellation, control-evidence, active-attempt, and outcome transitions.
 *
 * This private module keeps the repository's owner-fenced control plane
 * separate from provisioning and runtime-operation transitions. Its context
 * is concrete: callers supply the one session transaction boundary, row
 * accessors, settlement CAS, and injected outcome codec used by every method.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { RawSqlSession } from '@makaio/storage-drizzle';
import {
  assertRuntimeOutcomeFence,
  decodeDurableOutcome,
  durableOutcome,
  evaluateAttemptCancellation,
  evaluateAttemptControlReceipt,
  evaluateAttemptControlReport,
  sameDurableOutcome,
  snapshotAttemptControlReceipt,
  snapshotAttemptControlReport,
  snapshotAttemptOutcomeControl,
  snapshotRequestAttemptCancellationInput,
  snapshotRequestExecutionCancellationInput,
} from '@makaio/subsystem-workflow-engine';
import type {
  AttemptControlEvidenceDecision,
  DurableOutcome,
  ExecutionAttemptCancellationDecision,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRepository,
  OutcomeCodec,
  PendingAttemptAbandonmentDecision,
  RecordAttemptControlReceiptInput,
  ReportAttemptControlInput,
  RequestAttemptCancellationInput,
  RequestExecutionCancellationInput,
} from '@makaio/subsystem-workflow-engine';
import { decodeAttemptControlState, decodeOutcomeControl, toAttemptRecord } from './execution-attempt-types.js';
import { createCancellationReadOperations } from './execution-attempt-cancellation-read.js';
import type { ExecutionAttemptRows } from './execution-attempt-rows.js';
import { decideByWrite, isActiveAttemptRow } from './execution-attempt-transaction.js';
import type { ExecutionAttemptTransaction } from './execution-attempt-transaction.js';

type ControlMethods<TOutcome> = Pick<
  Required<ExecutionAttemptRepository<TOutcome>>,
  | 'requestAttemptCancellation'
  | 'requestCancellation'
  | 'readCancellation'
  | 'readAttemptCancellationControl'
  | 'recordAttemptControlReceipt'
  | 'reportAttemptControl'
  | 'getActiveAttempt'
  | 'canonicalizeOutcome'
  | 'decodeOutcome'
  | 'commitOutcome'
  | 'abandonPendingAttempt'
>;

/** Dependencies shared by the control-plane repository methods. */
export interface ExecutionAttemptControlContext<TOutcome> {
  readonly codec: OutcomeCodec<TOutcome>;
  readonly transaction: ExecutionAttemptTransaction;
  readonly rows: ExecutionAttemptRows;
  readonly settleAttempt: (
    session: RawSqlSession,
    executionAttemptId: string,
    settlementKind: 'outcome' | 'abandoned',
    guard: SQL,
  ) => Promise<{ readonly rowsAffected: number }>;
}

type CancellationControlContext<TOutcome> = Pick<ExecutionAttemptControlContext<TOutcome>, 'transaction' | 'rows'>;
type OutcomeControlContext<TOutcome> = Pick<
  ExecutionAttemptControlContext<TOutcome>,
  'codec' | 'transaction' | 'rows' | 'settleAttempt'
>;
type AbandonmentControlContext<TOutcome> = Pick<ExecutionAttemptControlContext<TOutcome>, 'transaction' | 'rows'>;

/**
 * Create the control-plane portion of the PostgreSQL attempt repository.
 * @param context - Codec, transaction, rows, and settlement dependencies.
 * @returns Cancellation, evidence, active-attempt, and outcome methods.
 */
export function createExecutionAttemptControlOperations<TOutcome>(
  context: ExecutionAttemptControlContext<TOutcome>,
): ControlMethods<TOutcome> {
  return {
    ...createCancellationRequestOperations(context),
    ...createCancellationReadOperations(context.rows, context.transaction.transact),
    ...createControlEvidenceOperations(context),
    ...createOutcomeReadOperations(context),
    ...createOutcomeCommitOperations(context),
    ...createAbandonmentControlOperations(context),
  };
}

/**
 * Create cancellation-request operations.
 * @param context - Transaction and row dependencies for cancellation writes.
 * @returns Attempt and execution cancellation request methods.
 */
function createCancellationRequestOperations<TOutcome>(
  context: CancellationControlContext<TOutcome>,
): Pick<ControlMethods<TOutcome>, 'requestAttemptCancellation' | 'requestCancellation'> {
  const { rows, transaction } = context;
  const { lockOwner, transact } = transaction;

  return {
    async requestAttemptCancellation(
      input: RequestAttemptCancellationInput,
    ): Promise<ExecutionAttemptCancellationDecision> {
      const snapshot = snapshotRequestAttemptCancellationInput(input);
      return transact(async (session) => {
        const row = await rows.readAttemptRow(session, snapshot.executionAttemptId);
        if (row === undefined || row.execution_id !== snapshot.executionId) return { kind: 'not-found' };
        const decision = evaluateAttemptCancellation(
          await rows.readCancellationInSession(session, snapshot.executionAttemptId),
          snapshot,
          new Date().toISOString(),
        );
        if (decision.kind === 'accepted') {
          await rows.writeCancellationInSession(session, snapshot.executionAttemptId, decision.intent);
        }
        return decision;
      });
    },

    async requestCancellation(input: RequestExecutionCancellationInput): Promise<void> {
      const snapshot = snapshotRequestExecutionCancellationInput(input);
      const request = { requestKey: crypto.randomUUID(), reason: snapshot.reason };
      await transact(async (session) => {
        // The owner lock must precede the fanout query: a concurrently created
        // attempt is then either included and closed or created after this
        // cancellation transaction completes.
        await lockOwner(session, snapshot.executionId);
        const attempts = await session.all<{ execution_attempt_id: string }>(
          sql`SELECT execution_attempt_id FROM execution_attempt WHERE execution_id = ${snapshot.executionId}`,
        );
        const requestedAt = new Date().toISOString();
        const decisions = [];
        for (const { execution_attempt_id: executionAttemptId } of attempts) {
          decisions.push({
            executionAttemptId,
            decision: evaluateAttemptCancellation(
              await rows.readCancellationInSession(session, executionAttemptId),
              request,
              requestedAt,
            ),
          });
        }
        for (const { decision } of decisions) {
          if (decision.kind === 'conflict')
            throw new Error('Generated cancellation request key conflicts with its receipt');
        }
        for (const { executionAttemptId, decision } of decisions) {
          if (decision.kind === 'accepted') {
            await rows.writeCancellationInSession(session, executionAttemptId, decision.intent);
          }
        }
      });
    },
  };
}

/**
 * Create control-evidence operations.
 * @param context - Transaction and row dependencies for evidence writes.
 * @returns Control receipt and report methods.
 */
function createControlEvidenceOperations<TOutcome>(
  context: CancellationControlContext<TOutcome>,
): Pick<ControlMethods<TOutcome>, 'recordAttemptControlReceipt' | 'reportAttemptControl'> {
  const { rows, transaction } = context;
  const { transact } = transaction;

  return {
    async recordAttemptControlReceipt(
      input: RecordAttemptControlReceiptInput,
    ): Promise<AttemptControlEvidenceDecision> {
      const snapshot = snapshotAttemptControlReceipt(input);
      const { executionId: _owner, ...receipt } = snapshot;
      return transact(async (session) => {
        const row = await rows.readAttemptRow(session, snapshot.executionAttemptId);
        const facts = await rows.readControlEvidenceInSession(session, snapshot.executionAttemptId);
        const previous = facts.find(
          (fact) =>
            fact.controlRevision === snapshot.controlRevision && fact.runtimeGeneration === snapshot.runtimeGeneration,
        );
        const decision = evaluateAttemptControlReceipt(
          row === undefined ? null : toAttemptRecord(row),
          await rows.readCancellationInSession(session, snapshot.executionAttemptId),
          previous?.receipt ?? null,
          snapshot,
        );
        if (decision.kind === 'accepted') {
          await session.run(sql`INSERT INTO execution_attempt_control_evidence
            (execution_attempt_id, control_revision, runtime_generation, receipt_json)
            VALUES (${snapshot.executionAttemptId}, ${snapshot.controlRevision}, ${snapshot.runtimeGeneration}, ${JSON.stringify(receipt)})
            ON CONFLICT (execution_attempt_id, control_revision, runtime_generation)
            DO UPDATE SET receipt_json = excluded.receipt_json`);
        }
        return decision;
      });
    },

    async reportAttemptControl(input: ReportAttemptControlInput): Promise<AttemptControlEvidenceDecision> {
      const snapshot = snapshotAttemptControlReport(input);
      const { executionId: _owner, ...report } = snapshot;
      return transact(async (session) => {
        const row = await rows.readAttemptRow(session, snapshot.executionAttemptId);
        const facts = await rows.readControlEvidenceInSession(session, snapshot.executionAttemptId);
        const previous = facts.find(
          (fact) =>
            fact.controlRevision === snapshot.controlRevision && fact.runtimeGeneration === snapshot.runtimeGeneration,
        );
        const decision = evaluateAttemptControlReport(
          row === undefined ? null : toAttemptRecord(row),
          await rows.readCancellationInSession(session, snapshot.executionAttemptId),
          previous?.report ?? null,
          snapshot,
        );
        if (decision.kind === 'accepted') {
          await session.run(sql`INSERT INTO execution_attempt_control_evidence
            (execution_attempt_id, control_revision, runtime_generation, report_json)
            VALUES (${snapshot.executionAttemptId}, ${snapshot.controlRevision}, ${snapshot.runtimeGeneration}, ${JSON.stringify(report)})
            ON CONFLICT (execution_attempt_id, control_revision, runtime_generation)
            DO UPDATE SET report_json = excluded.report_json`);
        }
        return decision;
      });
    },
  };
}

/**
 * Create outcome read operations.
 * @param context - Codec, transaction, and row dependencies for outcome reads.
 * @returns Active-attempt and outcome codec methods.
 */
function createOutcomeReadOperations<TOutcome>(
  context: OutcomeControlContext<TOutcome>,
): Pick<ControlMethods<TOutcome>, 'getActiveAttempt' | 'canonicalizeOutcome' | 'decodeOutcome'> {
  const { codec, rows, transaction } = context;
  const { lockOwner, transact } = transaction;

  return {
    async getActiveAttempt(executionId: string, executionAttemptId: string): Promise<ExecutionAttemptRecord | null> {
      return transact(async (session) => {
        // Lock before the pointer read so the owner cannot replace the active
        // attempt between observing the pointer and fetching its row.
        await lockOwner(session, executionId);
        if ((await rows.readActiveAttemptId(session, executionId)) !== executionAttemptId) return null;
        const row = await rows.readAttemptRow(session, executionAttemptId);
        return row === undefined ? null : toAttemptRecord(row);
      });
    },

    canonicalizeOutcome(outcome: TOutcome): DurableOutcome<TOutcome> {
      return durableOutcome(codec, outcome);
    },

    decodeOutcome(text: string): TOutcome {
      return decodeDurableOutcome(codec, text);
    },
  };
}

/**
 * Create the fenced outcome commit operation.
 * @param context - Codec, transaction, rows, and settlement dependencies for outcome commits.
 * @returns The outcome commit method.
 */
function createOutcomeCommitOperations<TOutcome>(
  context: OutcomeControlContext<TOutcome>,
): Pick<ControlMethods<TOutcome>, 'commitOutcome'> {
  const { codec, rows, settleAttempt, transaction } = context;
  const { lockOwner, transact } = transaction;

  return {
    async commitOutcome(
      input: ExecutionAttemptOutcomeCommit<TOutcome>,
    ): Promise<ExecutionAttemptOutcomeDecision<TOutcome>> {
      const runtimeGuard =
        input.runtimeFence === undefined
          ? sql`1 = 1`
          : sql`runtime_generation = ${input.runtimeFence.runtimeGeneration}
            AND ${
              input.runtimeFence.operationId === null
                ? sql`active_operation_id IS NULL`
                : sql`active_operation_id = ${input.runtimeFence.operationId}
                    AND active_operation_generation = ${input.runtimeFence.runtimeGeneration}`
            }`;
      return transact(async (session) => {
        await lockOwner(session, input.executionId);
        let controlObservation: ReturnType<typeof snapshotAttemptOutcomeControl> | null = null;
        return decideByWrite<ExecutionAttemptOutcomeDecision<TOutcome>>(
          async () => {
            if ((await rows.readActiveAttemptId(session, input.executionId)) !== input.executionAttemptId) {
              return { kind: 'fenced' };
            }
            const attemptRow = await rows.readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined) return { kind: 'fenced' };
            if (attemptRow.outcome_text !== null) {
              const outcome = decodeDurableOutcome(codec, attemptRow.outcome_text);
              return sameDurableOutcome(attemptRow.outcome_text, input.result.text)
                ? {
                    kind: 'duplicate',
                    outcome,
                    text: attemptRow.outcome_text,
                    controlObservation: decodeOutcomeControl(attemptRow.outcome_control_observation),
                  }
                : { kind: 'conflict' };
            }
            if (attemptRow.settlement_kind !== null) return { kind: 'conflict' };
            if (input.runtimeFence !== undefined) {
              assertRuntimeOutcomeFence(decodeAttemptControlState(attemptRow), input.runtimeFence);
            }
            controlObservation = snapshotAttemptOutcomeControl(
              await rows.readCancellationInSession(session, input.executionAttemptId),
            );
            return async () => {
              const committed = await session.run(sql`UPDATE execution_attempt SET outcome_text = ${input.result.text},
                outcome_control_observation = ${JSON.stringify(controlObservation)}
                WHERE execution_attempt_id = ${input.executionAttemptId}
                  AND outcome_text IS NULL AND settlement_kind IS NULL
                  AND ${runtimeGuard} AND ${isActiveAttemptRow()}`);
              if (committed.rowsAffected === 0) return committed;
              return settleAttempt(session, input.executionAttemptId, 'outcome', sql`outcome_text IS NOT NULL`);
            };
          },
          () => ({
            kind: 'accepted',
            outcome: decodeDurableOutcome(codec, input.result.text),
            text: input.result.text,
            controlObservation,
          }),
        );
      });
    },
  };
}

/**
 * Create the pending-attempt abandonment operation.
 * @param context - Transaction and row dependencies for owner-fenced abandonment.
 * @returns The pending-attempt abandonment method.
 */
function createAbandonmentControlOperations<TOutcome>(
  context: AbandonmentControlContext<TOutcome>,
): Pick<ControlMethods<TOutcome>, 'abandonPendingAttempt'> {
  const { rows, transaction } = context;
  const { lockOwner, transact } = transaction;

  return {
    async abandonPendingAttempt(
      executionAttemptId: string,
      executionId: string,
    ): Promise<PendingAttemptAbandonmentDecision> {
      return transact(async (session) => {
        await lockOwner(session, executionId);
        return decideByWrite<PendingAttemptAbandonmentDecision>(
          async () => {
            if ((await rows.readActiveAttemptId(session, executionId)) !== executionAttemptId)
              return { kind: 'fenced' };
            const row = await rows.readAttemptRow(session, executionAttemptId);
            if (row === undefined) return { kind: 'fenced' };
            const attempt = toAttemptRecord(row);
            if (attempt.status === 'allocated') return { kind: 'allocated' };
            if (attempt.status === 'provisioning') return { kind: 'provisioning' };
            if (attempt.status === 'settled') {
              return { kind: attempt.settlementKind === 'abandoned' ? 'already-abandoned' : 'already-settled' };
            }
            return () =>
              session.run(sql`UPDATE execution_attempt
                SET status = ${'settled'}, settlement_kind = ${'abandoned'}, claimable = ${0}, operation_start_gate = ${'closed'}
                WHERE execution_attempt_id = ${executionAttemptId} AND execution_id = ${executionId}
                  AND status = ${'pending'} AND settlement_kind IS NULL AND ${isActiveAttemptRow()}`);
          },
          { kind: 'abandoned' },
        );
      });
    },
  };
}
