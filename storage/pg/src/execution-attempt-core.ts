/** Core creation, replay, allocation, and recovery operations for PostgreSQL attempts. */
import { sql, type SQL } from 'drizzle-orm';
import { isPostgresUniqueViolationError } from './errors.js';
import type { BoundedRecoveryEvidence } from '@makaio/contracts';
import type { RawSqlSession } from '@makaio/storage-drizzle';
import {
  ATTEMPT_OPERATION_START_GATES,
  DuplicateExecutionAttemptError,
  replayEnsuredAttempt,
  readAttemptSettlementSnapshot,
  sameAllocationRef,
  snapshotEnsureExecutionAttemptPersistenceInput,
  snapshotReadAttemptSettlementInput,
} from '@makaio/subsystem-workflow-engine';
import type {
  AllocationRecordingDecision,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AttemptSettlementRead,
  BootstrapStartState,
  DiscoveredAllocationDecision,
  EnsureExecutionAttemptDecision,
  EnsureExecutionAttemptPersistenceInput,
  ExecutionAttemptCreate,
  ExecutionAttemptRecord,
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  ExecutionAttemptSettlementKind,
  ListOpenProviderOperationsInput,
  OpenProviderOperationRecord,
  OutcomeCodec,
  ProviderOperationClaim,
  ReadAttemptSettlementInput,
  ReadBootstrapStartStateInput,
  RecordAllocationInput,
  RecoverableAttemptRecord,
} from '@makaio/subsystem-workflow-engine';
import {
  INITIAL_ATTEMPT_CONTROL_STATE,
  createAttemptTiming,
  decodeOutcomeControl,
  normalizeInstant,
  parseAllocationRef,
  parseAllocationRefEvolution,
  parseInstruction,
  parseMember,
  requireAllocationRefProvider,
  toRecoverableAttempt,
} from './execution-attempt-types.js';
import {
  toAttemptRecord,
  toOperationRecord,
  type AttemptRow,
  type OperationRow,
  type ExecutionAttemptRows,
} from './execution-attempt-rows.js';
import type { ActiveAttemptRow } from './execution-attempt-types.js';
import {
  claimAuthorizes,
  claimHolds,
  decideByWrite,
  isActiveAttemptRow,
  type ExecutionAttemptTransaction,
} from './execution-attempt-transaction.js';

export interface ExecutionAttemptCoreOperations<TOutcome> {
  readonly methods: Pick<
    Required<ExecutionAttemptRepository<TOutcome>>,
    'createAttempt' | 'ensureAttempt' | 'readAttemptSettlement' | 'readBootstrapStartState'
  >;
  readonly recovery: ExecutionAttemptRecoveryOperations;
  readonly applyAllocation: ApplyAllocation;
  readonly settleAttempt: SettleAttempt;
  readonly settleAndCompletePreallocationOperation: SettleAndCompletePreallocationOperation;
}

interface ExecutionAttemptCoreContext<TOutcome> {
  readonly codec: OutcomeCodec<TOutcome>;
  readonly transaction: ExecutionAttemptTransaction;
  readonly rows: ExecutionAttemptRows;
}

type ExecutionAttemptDataContext = Pick<ExecutionAttemptCoreContext<never>, 'transaction' | 'rows'>;

type ApplyAllocation = (
  input: RecordAllocationInput,
  bootstrapClaimable: boolean,
) => Promise<AllocationRecordingDecision>;

type SettleAttempt = (
  session: RawSqlSession,
  executionAttemptId: string,
  settlementKind: NonNullable<ExecutionAttemptSettlementKind>,
  guard: SQL,
) => Promise<{ readonly rowsAffected: number }>;
type SettleAndCompletePreallocationOperation = (
  session: RawSqlSession,
  executionAttemptId: string,
  claim: ProviderOperationClaim,
  guard: SQL,
  evidence: BoundedRecoveryEvidence,
  alreadySettled: boolean,
) => Promise<{ readonly rowsAffected: number }>;

/**
 * Creates the guarded attempt-settlement write operation.
 * @returns The attempt-settlement write operation.
 */
function createSettleAttempt(): SettleAttempt {
  return (session, executionAttemptId, settlementKind, guard) =>
    session.run(sql`UPDATE execution_attempt SET status = ${'settled'}, settlement_kind = ${settlementKind}, claimable = ${0}, operation_start_gate = ${'closed'}
      WHERE execution_attempt_id = ${executionAttemptId} AND settlement_kind IS NULL AND ${guard}`);
}
/**
 * Creates the operation that records completion evidence after pre-allocation settlement.
 * @param rows - Row accessors used to confirm evidence persistence.
 * @param settleAttempt - Guarded write operation used to abandon the attempt.
 * @returns The pre-allocation settlement and completion operation.
 */
function createSettleAndCompletePreallocationOperation(
  rows: ExecutionAttemptRows,
  settleAttempt: SettleAttempt,
): SettleAndCompletePreallocationOperation {
  return async (session, executionAttemptId, claim, guard, evidence, alreadySettled) => {
    if (alreadySettled) {
      return session.run(sql`UPDATE provider_operation SET completion_evidence = ${JSON.stringify(evidence)}
      WHERE execution_attempt_id = ${executionAttemptId} AND ${claimHolds(claim)} AND completion_evidence IS NULL`);
    }
    const settled = await settleAttempt(session, executionAttemptId, 'abandoned', guard);
    if (settled.rowsAffected === 0) return settled;
    const proof = await session.run(sql`UPDATE provider_operation SET completion_evidence = ${JSON.stringify(evidence)}
        WHERE execution_attempt_id = ${executionAttemptId} AND ${claimHolds(claim)} AND completion_evidence IS NULL`);
    if (
      proof.rowsAffected === 0 &&
      (await rows.readOperationRow(session, executionAttemptId))?.completion_evidence === null
    ) {
      throw new Error('Pre-allocation settlement succeeded without provider completion evidence');
    }
    return settled;
  };
}
/**
 * Creates the compare-and-set allocation recording operation.
 * @param context - Transaction boundary and row accessors used by the operation.
 * @returns The allocation recording operation.
 */
function createApplyAllocation(context: ExecutionAttemptDataContext): ApplyAllocation {
  const {
    rows,
    transaction: { transact },
  } = context;
  return (input, bootstrapClaimable) => {
    const allocationRef = parseAllocationRef(input.allocationRef);
    const claimable = bootstrapClaimable
      ? sql`CASE WHEN settlement_kind IS NULL AND ${isActiveAttemptRow()} THEN 1 ELSE 0 END`
      : sql`${0}`;
    return transact((session) =>
      decideByWrite<AllocationRecordingDecision>(
        async () => {
          const authorization = await rows.authorize(session, input.claim);
          if (authorization.kind !== 'not-found') requireAllocationRefProvider(authorization.attempt, allocationRef);
          if (authorization.kind === 'resolved')
            return { kind: 'resolved', allocationRef: authorization.attempt.allocationRef };
          if (authorization.kind !== 'authorized') return { kind: authorization.kind };
          const { attempt } = authorization;
          if (attempt.allocationRef !== null)
            return sameAllocationRef(attempt.allocationRef, allocationRef)
              ? { kind: 'duplicate', allocationRef: attempt.allocationRef }
              : { kind: 'conflict', allocationRef: attempt.allocationRef };
          return async () => {
            const applied =
              await session.run(sql`UPDATE execution_attempt SET status = CASE WHEN settlement_kind IS NULL THEN ${'allocated'} ELSE status END,
          allocation_ref = ${JSON.stringify(allocationRef)}, claimable = ${claimable}
          WHERE execution_attempt_id = ${attempt.executionAttemptId} AND allocation_ref IS NULL AND ${claimAuthorizes(input.claim)}`);
            if (applied.rowsAffected > 0)
              await session.run(
                sql`UPDATE provider_operation SET obligation = ${'allocation-control'} WHERE execution_attempt_id = ${attempt.executionAttemptId}`,
              );
            return applied;
          };
        },
        { kind: 'recorded' },
      ),
    );
  };
}
/**
 * Creates and activates an execution attempt inside an existing transaction.
 * @param context - Transaction boundary that provides the execution owner lock.
 * @param session - Transaction session that persists the attempt.
 * @param input - Validated attempt creation input.
 * @param timing - Creation and bootstrap deadline timestamps.
 * @returns The newly persisted execution attempt record.
 */
async function createAttemptInSession(
  context: Pick<ExecutionAttemptDataContext, 'transaction'>,
  session: RawSqlSession,
  input: ExecutionAttemptCreate,
  timing: ReturnType<typeof createAttemptTiming>,
): Promise<ExecutionAttemptRecord> {
  const { lockOwner } = context.transaction;
  await lockOwner(session, input.executionId);
  try {
    await session.run(sql`INSERT INTO execution_attempt (execution_attempt_id, execution_id, instruction, status, claimable, created_at, bootstrap_deadline_at)
        VALUES (${input.executionAttemptId}, ${input.executionId}, ${JSON.stringify(input.instruction)}, ${'pending'}, ${0}, ${timing.createdAt}, ${timing.bootstrapDeadlineAt})`);
  } catch (error) {
    if (!isPostgresUniqueViolationError(error)) throw error;
    throw new DuplicateExecutionAttemptError(input.executionAttemptId, { cause: error });
  }
  await session.run(sql`UPDATE execution_attempt SET claimable = ${0} WHERE execution_attempt_id =
      (SELECT execution_attempt_id FROM active_execution_attempt WHERE execution_id = ${input.executionId}) AND status = ${'allocated'}`);
  await session.run(sql`UPDATE execution_attempt SET operation_start_gate = ${'closed'} WHERE execution_attempt_id =
      (SELECT execution_attempt_id FROM active_execution_attempt WHERE execution_id = ${input.executionId})`);
  await session.run(sql`INSERT INTO active_execution_attempt (execution_id, execution_attempt_id) VALUES (${input.executionId}, ${input.executionAttemptId})
      ON CONFLICT(execution_id) DO UPDATE SET execution_attempt_id = excluded.execution_attempt_id`);
  return {
    ...INITIAL_ATTEMPT_CONTROL_STATE,
    executionAttemptId: input.executionAttemptId,
    executionId: input.executionId,
    instruction: input.instruction,
    preparationReceipts: Object.freeze([]),
    status: 'pending',
    allocationRef: null,
    createdAt: timing.createdAt,
    bootstrapDeadlineAt: timing.bootstrapDeadlineAt,
    providerId: null,
    allocationLifetime: null,
    provisionerIncarnationId: null,
    settlementKind: null,
    claimable: false,
    claimExpiresAt: null,
  };
}
/**
 * Creates recovery operations over persisted attempts and provider operations.
 * @param context - Transaction boundary and row accessors used by recovery operations.
 * @param applyAllocation - Allocation operation shared with discovered-allocation recovery.
 * @returns The recovery operation surface.
 */
function createRecoveryOperations(
  context: ExecutionAttemptDataContext,
  applyAllocation: ApplyAllocation,
): ExecutionAttemptRecoveryOperations {
  const { rows } = context;
  const { transact } = context.transaction;
  return {
    async getAttemptWithAllocation(id) {
      return transact(async (session) => {
        const row = await rows.readAttemptRow(session, id);
        return row === undefined ? null : toAttemptRecord(row);
      });
    },
    async recordDiscoveredAllocation(input): Promise<DiscoveredAllocationDecision> {
      return applyAllocation(input, false);
    },
    async evolveAllocationRef(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision> {
      const { currentRef, nextRef } = parseAllocationRefEvolution(input);
      return transact((session) =>
        decideByWrite<AllocationRefEvolutionDecision>(
          async () => {
            const authorization = await rows.authorize(session, input.claim);
            if (authorization.kind === 'stale')
              return { kind: 'stale', storedRef: authorization.attempt.allocationRef };
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt, attemptRow } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.allocationRef === null) return { kind: 'not-allocated' };
            if (!sameAllocationRef(attempt.allocationRef, currentRef))
              return { kind: 'stale', storedRef: attempt.allocationRef };
            return () =>
              session.run(sql`UPDATE execution_attempt SET allocation_ref = ${JSON.stringify(nextRef)} WHERE execution_attempt_id = ${attempt.executionAttemptId}
          AND execution_id = ${input.executionId} AND allocation_ref = ${attemptRow.allocation_ref} AND ${claimAuthorizes(input.claim)}`);
          },
          { kind: 'evolved' },
        ),
      );
    },
    async getRecoverableAttempts(executionId): Promise<readonly RecoverableAttemptRecord[]> {
      return transact(async (session) => {
        const values =
          await session.all<AttemptRow>(sql`SELECT * FROM execution_attempt WHERE execution_id = ${executionId} AND status = ${'allocated'}
        AND settlement_kind IS NULL AND allocation_ref IS NOT NULL AND claimable = ${1} AND (claim_expires_at IS NULL OR claim_expires_at >= ${new Date().toISOString()})
        ORDER BY created_at ASC, execution_attempt_id COLLATE "C" ASC`);
        return values.map((row) => toRecoverableAttempt(toAttemptRecord(row)));
      });
    },
    async listOpenProviderOperations(
      input: ListOpenProviderOperationsInput,
    ): Promise<readonly OpenProviderOperationRecord[]> {
      const observedAt = normalizeInstant(input.observedAt);
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0)
        throw new RangeError('Provider-operation recovery limit must be a positive safe integer');
      return transact(async (session) => {
        const values = await session.all<AttemptRow & OperationRow>(
          sql`SELECT attempt.*, operation.generation, operation.owner_id, operation.token, operation.lease_expires_at, operation.obligation, operation.failure_count, operation.last_failure, operation.completion_evidence FROM execution_attempt AS attempt INNER JOIN provider_operation AS operation ON operation.execution_attempt_id = attempt.execution_attempt_id WHERE (operation.completion_evidence IS NULL OR attempt.settlement_kind IS NULL) AND (operation.owner_id IS NULL OR operation.lease_expires_at IS NULL OR operation.lease_expires_at <= ${observedAt}) ORDER BY attempt.created_at ASC, attempt.execution_attempt_id COLLATE "C" ASC LIMIT ${input.limit}`,
        );
        return values.map((row) => ({ attempt: toAttemptRecord(row), operation: toOperationRecord(row) }));
      });
    },
  };
}
/**
 * Creates the repository methods for attempt lifecycle persistence.
 * @param context - Codec, transaction boundary, and row accessors used by repository methods.
 * @returns The repository method surface.
 */
function createRepositoryMethods<TOutcome>(
  context: ExecutionAttemptCoreContext<TOutcome>,
): ExecutionAttemptCoreOperations<TOutcome>['methods'] {
  const {
    codec,
    rows,
    transaction: { lockOwner, transact },
  } = context;
  return {
    async createAttempt(input) {
      const snapshot = { ...input, instruction: parseInstruction(input.instruction) };
      return transact((session) =>
        createAttemptInSession(context, session, snapshot, createAttemptTiming(snapshot.bootstrapTimeoutMs)),
      );
    },
    async ensureAttempt(input: EnsureExecutionAttemptPersistenceInput): Promise<EnsureExecutionAttemptDecision> {
      const snapshot = snapshotEnsureExecutionAttemptPersistenceInput(input);
      return transact(async (session) => {
        await lockOwner(session, snapshot.executionId);
        const [binding] = await session.all<ActiveAttemptRow>(
          sql`SELECT execution_attempt_id FROM execution_attempt_request WHERE execution_id = ${snapshot.executionId} AND request_key = ${snapshot.requestKey}`,
        );
        if (binding !== undefined) {
          const row = await rows.readAttemptRow(session, binding.execution_attempt_id);
          return replayEnsuredAttempt(snapshot, row === undefined ? null : toAttemptRecord(row));
        }
        const attempt = await createAttemptInSession(
          context,
          session,
          snapshot,
          createAttemptTiming(snapshot.bootstrapTimeoutMs),
        );
        await session.run(
          sql`INSERT INTO execution_attempt_request (execution_id, request_key, execution_attempt_id) VALUES (${snapshot.executionId}, ${snapshot.requestKey}, ${attempt.executionAttemptId})`,
        );
        return { kind: 'created', attempt: structuredClone(attempt) };
      });
    },
    async readAttemptSettlement(input: ReadAttemptSettlementInput): Promise<AttemptSettlementRead<TOutcome>> {
      const snapshot = snapshotReadAttemptSettlementInput(input);
      return transact(async (session) => {
        const row = await rows.readAttemptRow(session, snapshot.executionAttemptId);
        if (row === undefined || row.execution_id !== snapshot.executionId) return { kind: 'not-found' };
        return readAttemptSettlementSnapshot(
          snapshot,
          {
            attempt: toAttemptRecord(row),
            activeAttemptId: await rows.readActiveAttemptId(session, snapshot.executionId),
            outcomeText: row.outcome_text,
            controlObservation: decodeOutcomeControl(row.outcome_control_observation),
          },
          codec,
        );
      });
    },
    async readBootstrapStartState(input: ReadBootstrapStartStateInput): Promise<BootstrapStartState | null> {
      return transact(async (session) => {
        const row = await rows.readAttemptRow(session, input.executionAttemptId);
        if (row === undefined || row.execution_id !== input.executionId) return null;
        return {
          settled: row.settlement_kind !== null,
          active: (await rows.readActiveAttemptId(session, input.executionId)) === input.executionAttemptId,
          allocated: row.allocation_ref !== null,
          allocationTerminated: await rows.allocationTerminated(session, input.executionAttemptId),
          operationStartGate: parseMember(
            ATTEMPT_OPERATION_START_GATES,
            row.operation_start_gate,
            'operation_start_gate',
          ),
          bootstrapDeadlineAt: row.bootstrap_deadline_at,
        };
      });
    },
  };
}

/**
 * Create core attempt persistence, allocation, and recovery operations.
 * @param options - Codec, transaction boundary, and row accessors to compose.
 * @returns Core repository members and provider-transition dependencies.
 */
export function createExecutionAttemptCore<TOutcome>(
  options: ExecutionAttemptCoreContext<TOutcome>,
): ExecutionAttemptCoreOperations<TOutcome> {
  const settleAttempt = createSettleAttempt();
  const applyAllocation = createApplyAllocation(options);
  return {
    methods: createRepositoryMethods(options),
    recovery: createRecoveryOperations(options, applyAllocation),
    applyAllocation,
    settleAttempt,
    settleAndCompletePreallocationOperation: createSettleAndCompletePreallocationOperation(options.rows, settleAttempt),
  };
}
