/**
 * Transactional SQLite realization of the execution attempt port.
 *
 * Test-only support, never production persistence. It exists so the port's
 * fencing rules are proven against real transactions, real row constraints,
 * and real cross-connection visibility instead of against a JavaScript object
 * that can only ever agree with itself. Its tables carry a `test_` prefix and
 * are provisioned by this module, so it never participates in the storage
 * migration chain.
 * @packageDocumentation
 */
import { sql, type SQL } from 'drizzle-orm';
import type { ExecutionAttemptInstruction, ProviderAllocationRef } from '@makaio/contracts';
import {
  BoundedRecoveryEvidenceSchema,
  ExecutionAttemptOperationKindSchema,
  ProviderAllocationRefSchema,
  WorkerAllocationLifetimeSchema,
  type BoundedRecoveryEvidence,
} from '@makaio/contracts';
import {
  getRawSqlExecutor,
  isSqliteUniqueViolationError,
  serializeDatabaseOperation,
  serializeByKey,
  type MakaioDatabase,
  type RawSqlExecutor,
  type RawSqlSession,
} from '@makaio/storage-drizzle';
import {
  ATTEMPT_OPERATION_START_GATES,
  DuplicateExecutionAttemptError,
  EXECUTION_ATTEMPT_SETTLEMENT_KINDS,
  EXECUTION_ATTEMPT_STATUSES,
  decodeDurableOutcome,
  durableOutcome,
  evaluateAttemptReachability,
  evaluateRuntimeRegistration,
  evaluateOperationAdmission,
  evaluateOperationCompletion,
  evaluateRuntimeReadiness,
  evaluatePreparationReport,
  evaluateProvisionerIncarnationLoss,
  assertRuntimeOutcomeFence,
  sameAllocationRef,
  sameDurableOutcome,
} from '../execution-attempt-repository.js';
import {
  snapshotEnsureExecutionAttemptPersistenceInput,
  snapshotReadAttemptSettlementInput,
  replayEnsuredAttempt,
  readAttemptSettlementSnapshot,
} from '../execution-attempt-owner-recovery.js';
import type {
  AdmitOperationInput,
  AllocationRecordingDecision,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AllocationTerminationDecision,
  AttemptControlState,
  AttemptReachabilityDecision,
  BeginProvisioningInput,
  CompleteOperationInput,
  CompleteProviderOperationInput,
  DiscoveredAllocationDecision,
  DurableOutcome,
  ExecutionAttemptCreate,
  EnsureExecutionAttemptPersistenceInput,
  EnsureExecutionAttemptDecision,
  ReadAttemptSettlementInput,
  AttemptSettlementRead,
  BootstrapStartState,
  ReadBootstrapStartStateInput,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  GetInstructionInput,
  ReportOperationInput,
  OperationReportDecision,
  ExecutionAttemptSettlementKind,
  HandoffProviderOperationInput,
  InfrastructureFailureDecision,
  ListOpenProviderOperationsInput,
  MarkRuntimeReadyInput,
  OperationAdmissionDecision,
  OperationCompletionDecision,
  OpenProviderOperationRecord,
  OutcomeCodec,
  PendingAttemptAbandonmentDecision,
  ProvisionerIncarnationLossDecision,
  ProvisioningAbsenceDecision,
  ProvisioningClaimDecision,
  RecordAllocationInput,
  RecordAllocationTerminatedInput,
  RecordInfrastructureFailureInput,
  RecordProviderOperationUncertaintyInput,
  RecordProvisionerIncarnationLostInput,
  RecordProvisioningAbsentInput,
  RecoverableAttemptRecord,
  RegisterRuntimeInput,
  RenewProviderOperationClaimInput,
  RuntimeReadinessDecision,
  RuntimeRegistrationDecision,
  TakeOverProviderOperationInput,
} from '../execution-attempt-repository.js';
import { isProviderOperationResolved, PROVIDER_OPERATION_OBLIGATIONS } from '../provider-operation.js';
import type {
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationCompletionDecision,
  ProviderOperationMutationDecision,
  ProviderOperationOwnershipRecord,
} from '../provider-operation.js';
import {
  INITIAL_ATTEMPT_CONTROL_STATE,
  createAttemptTiming,
  instantOf,
  normalizeInstant,
  parsePreparationResult,
  parsePreparationReceipts,
  parseAllocationLifetime,
  parseAllocationRef,
  parseAllocationRefEvolution,
  requireAllocationRefProvider,
  toRecoverableAttempt,
} from './attempt-record-codec.js';
import { parseInstruction } from '../attempt-value-snapshot.js';

// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────

/**
 * Canonical attempt state, the fenced operation beside it, and the
 * active-attempt pointer that decides which attempt may bootstrap.
 *
 * The pointer is a table rather than a column so changing it is a row write
 * that participates in the same transaction as the attempt insert, exactly as
 * a durable implementation must make it.
 */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS test_execution_attempt (
     execution_attempt_id TEXT PRIMARY KEY,
     execution_id TEXT NOT NULL,
     instruction TEXT NOT NULL,
     preparation_receipts TEXT NOT NULL DEFAULT '[]',
     status TEXT NOT NULL,
     provider_id TEXT,
     allocation_lifetime TEXT,
     provisioner_incarnation_id TEXT,
     allocation_ref TEXT,
     settlement_kind TEXT,
     workflow_result TEXT,
     claimable INTEGER NOT NULL DEFAULT 0,
     claim_expires_at TEXT,
     created_at TEXT NOT NULL,
     bootstrap_deadline_at TEXT,
     runtime_generation INTEGER NOT NULL DEFAULT 0,
     runtime_incarnation_id TEXT,
     runtime_ready_at TEXT,
     operation_start_gate TEXT NOT NULL DEFAULT 'open',
     active_operation_id TEXT,
     active_operation_kind TEXT,
     active_operation_key TEXT,
     active_operation_generation INTEGER,
     active_operation_admitted_at TEXT,
     last_completed_operation_id TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS test_active_execution_attempt (
     execution_id TEXT PRIMARY KEY,
     execution_attempt_id TEXT NOT NULL
       REFERENCES test_execution_attempt(execution_attempt_id)
   )`,
  `CREATE TABLE IF NOT EXISTS test_execution_attempt_request (
     execution_id TEXT NOT NULL,
     request_key TEXT NOT NULL,
     execution_attempt_id TEXT NOT NULL
       REFERENCES test_execution_attempt(execution_attempt_id),
     PRIMARY KEY (execution_id, request_key)
   )`,
  `CREATE TABLE IF NOT EXISTS test_provider_operation (
     execution_attempt_id TEXT PRIMARY KEY
       REFERENCES test_execution_attempt(execution_attempt_id),
     generation INTEGER NOT NULL,
     owner_id TEXT,
     token TEXT,
     lease_expires_at TEXT,
     obligation TEXT NOT NULL,
     failure_count INTEGER NOT NULL DEFAULT 0,
     last_failure TEXT,
     completion_evidence TEXT
   )`,
] as const;

// ─────────────────────────────────────────────────────────────
// Stored row shapes
// ─────────────────────────────────────────────────────────────

/** One row of `test_execution_attempt`, exactly as SQLite returns it. */
interface AttemptRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
  readonly execution_id: string;
  readonly instruction: string;
  readonly preparation_receipts: string;
  readonly status: string;
  readonly provider_id: string | null;
  readonly allocation_lifetime: string | null;
  readonly provisioner_incarnation_id: string | null;
  readonly allocation_ref: string | null;
  readonly settlement_kind: string | null;
  readonly workflow_result: string | null;
  readonly claimable: number;
  readonly claim_expires_at: string | null;
  readonly created_at: string;
  readonly bootstrap_deadline_at: string | null;
  readonly runtime_generation: number;
  readonly runtime_incarnation_id: string | null;
  readonly runtime_ready_at: string | null;
  readonly operation_start_gate: string;
  readonly active_operation_id: string | null;
  readonly active_operation_kind: string | null;
  readonly active_operation_key: string | null;
  readonly active_operation_generation: number | null;
  readonly active_operation_admitted_at: string | null;
  readonly last_completed_operation_id: string | null;
}

/** One row of `test_provider_operation`, exactly as SQLite returns it. */
interface OperationRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
  readonly generation: number;
  readonly owner_id: string | null;
  readonly token: string | null;
  readonly lease_expires_at: string | null;
  readonly obligation: string;
  readonly failure_count: number;
  readonly last_failure: string | null;
  readonly completion_evidence: string | null;
}

/** One row of `test_active_execution_attempt`. */
interface ActiveAttemptRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
}

/**
 * Narrow a stored string to a member of the port's own vocabulary.
 *
 * The candidate lists are the constant arrays the port derives its types
 * from, so this can never drift from them. A durable row carrying a value
 * outside the vocabulary is corruption, not an alternative state, and must
 * never be silently mapped onto a valid one.
 * @param members - The port's constant array of legal members.
 * @param value - Value read back from storage.
 * @param column - Column name, for the failure message.
 * @returns The stored value, narrowed to the member type.
 * @throws When the stored value is outside the vocabulary.
 * @typeParam TMember - Member union the column is constrained to.
 */
function parseMember<TMember extends string>(members: readonly TMember[], value: string, column: string): TMember {
  const member = members.find((candidate) => candidate === value);
  if (member === undefined) {
    throw new Error(`Stored '${column}' value '${value}' is not part of the port's vocabulary`);
  }
  return member;
}

/**
 * Parse a nullable JSON column through the public schema that owns its shape.
 * @param json - Serialized column value, or `null` when the column is unset.
 * @param parse - Public schema parse function for the column's type.
 * @returns The parsed value, or `null` when the column is unset.
 * @typeParam TValue - Value type the column stores.
 */
function parseJsonColumn<TValue>(json: string | null, parse: (value: unknown) => TValue): TValue | null {
  return json === null ? null : parse(JSON.parse(json));
}

/**
 * Map an attempt row onto the port's runtime and operation control state.
 *
 * The ten columns are decoded together because every decision that reads one
 * of them reads several: a realization that narrowed them one call site at a
 * time would be free to disagree with itself about what an unset column means.
 * @param row - Row read from `test_execution_attempt`.
 * @returns The ten control facts the port defines.
 */
function decodeAttemptControlState(row: AttemptRow): AttemptControlState {
  return {
    runtimeGeneration: row.runtime_generation,
    runtimeIncarnationId: row.runtime_incarnation_id,
    runtimeReadyAt: row.runtime_ready_at,
    operationStartGate: parseMember(ATTEMPT_OPERATION_START_GATES, row.operation_start_gate, 'operation_start_gate'),
    activeOperationId: row.active_operation_id,
    // Narrowed through the contract's own vocabulary rather than a literal of
    // this module's: the kind crosses the wire, so a stored value outside it is
    // corruption in exactly the sense `parseMember` means.
    activeOperationKind:
      row.active_operation_kind === null ? null : ExecutionAttemptOperationKindSchema.parse(row.active_operation_kind),
    activeOperationKey: row.active_operation_key,
    activeOperationGeneration: row.active_operation_generation,
    activeOperationAdmittedAt: row.active_operation_admitted_at,
    lastCompletedOperationId: row.last_completed_operation_id,
  };
}

/**
 * Map an attempt row onto the port's attempt record.
 * @param row - Row read from `test_execution_attempt`.
 * @returns The JSON-safe attempt record the port defines.
 */
function toAttemptRecord(row: AttemptRow): ExecutionAttemptRecord {
  return {
    ...decodeAttemptControlState(row),
    executionAttemptId: row.execution_attempt_id,
    executionId: row.execution_id,
    instruction: parseInstruction(JSON.parse(row.instruction)),
    preparationReceipts: parsePreparationReceipts(JSON.parse(row.preparation_receipts)),
    status: parseMember(EXECUTION_ATTEMPT_STATUSES, row.status, 'status'),
    allocationRef: parseJsonColumn<ProviderAllocationRef>(row.allocation_ref, (value) =>
      ProviderAllocationRefSchema.parse(value),
    ),
    createdAt: row.created_at,
    bootstrapDeadlineAt: row.bootstrap_deadline_at,
    providerId: row.provider_id,
    allocationLifetime:
      row.allocation_lifetime === null ? null : WorkerAllocationLifetimeSchema.parse(row.allocation_lifetime),
    provisionerIncarnationId: row.provisioner_incarnation_id,
    settlementKind:
      row.settlement_kind === null
        ? null
        : parseMember(EXECUTION_ATTEMPT_SETTLEMENT_KINDS, row.settlement_kind, 'settlement_kind'),
    claimable: row.claimable !== 0,
    claimExpiresAt: row.claim_expires_at,
  };
}

/**
 * Map an operation row onto the port's ownership record.
 * @param row - Row read from `test_provider_operation`.
 * @returns The JSON-safe ownership record the port defines.
 */
function toOperationRecord(row: OperationRow): ProviderOperationOwnershipRecord {
  return {
    executionAttemptId: row.execution_attempt_id,
    generation: row.generation,
    ownerId: row.owner_id,
    token: row.token,
    leaseExpiresAt: row.lease_expires_at,
    obligation: parseMember(PROVIDER_OPERATION_OBLIGATIONS, row.obligation, 'obligation'),
    failureCount: row.failure_count,
    lastFailure: parseJsonColumn<BoundedRecoveryEvidence>(row.last_failure, (value) =>
      BoundedRecoveryEvidenceSchema.parse(value),
    ),
    completionEvidence: parseJsonColumn<BoundedRecoveryEvidence>(row.completion_evidence, (value) =>
      BoundedRecoveryEvidenceSchema.parse(value),
    ),
  };
}

// ─────────────────────────────────────────────────────────────
// Transaction control
// ─────────────────────────────────────────────────────────────

/**
 * Serializes schema initialization per SQLite database file, within this process.
 *
 * Repository construction may begin concurrently on two handles for the same
 * database. DDL must not race in that case. Transitions use a separate gate
 * with the same database identity because libsql can otherwise retain an
 * unfinished statement after a contended commit and poison the shared test
 * fixture.
 *
 * The map is module state, so the guarantee is process-local: two processes
 * over one database file do not share a gate and fall back to SQLite's own
 * locking. That is adequate because this is single-process test support.
 *
 * A durable realization on a store with snapshot isolation must still take
 * the write lock up front, for the reason documented on `executeTransaction`
 * in `@makaio/storage-drizzle`: two read-modify-write transactions on
 * isolated snapshots can otherwise both act on the same stale read. Every
 * transition below therefore also repeats its guard inside the predicate of
 * its own write.
 */
const schemaGates = new Map<string, Promise<void>>();

/** Process-local transition queues keyed by the SQLite database identity. */
const transactionGates = new Map<string, Promise<void>>();

const SQLITE_BUSY_RETRY_LIMIT = 100;

/**
 * Whether an error is SQLite declining a writer because another connection
 * currently owns the write lock.
 * @param error - Error raised while starting a transaction.
 * @returns Whether the error represents transient SQLite write contention.
 */
function isSqliteBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly message?: unknown; readonly cause?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return (
    message.includes('SQLITE_BUSY') ||
    // Drizzle's libsql wrapper retains the native busy diagnostic only on its
    // non-enumerable cause. These transaction-control statements have no
    // other recoverable failure mode in this adapter.
    message.startsWith('Failed query: BEGIN IMMEDIATE') ||
    message.startsWith('Failed query: COMMIT') ||
    isSqliteBusyError(candidate.cause)
  );
}

/**
 * Whether SQLite confirms that the connection has no transaction to roll back.
 * @param error - Error raised by `ROLLBACK`.
 * @returns Whether the connection is already outside a transaction.
 */
function isNoActiveTransactionError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { readonly message?: unknown; readonly cause?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  return message.includes('no transaction is active') || isNoActiveTransactionError(candidate.cause);
}

/**
 * Yield so a competing SQLite writer can release its lock.
 *
 * The adapter sets `busy_timeout` to zero on its test-only handle. SQLite then
 * reports a held lock immediately; yielding lets the lock holder advance
 * without blocking Node's event loop.
 */
async function yieldForSqliteWriter(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Commit an immediate transaction after a contending statement has finished.
 *
 * SQLite keeps the transaction open when `COMMIT` reports `SQLITE_BUSY`, so
 * retrying the commit preserves its already-computed transition rather than
 * rerunning it from a different durable state.
 * @param session - Session owning the open transaction.
 * @throws When the commit remains busy past the bounded retry window.
 */
async function commitTransaction(session: RawSqlSession): Promise<void> {
  for (let retries = 0; ; retries += 1) {
    try {
      await session.run(sql.raw('COMMIT'));
      return;
    } catch (error) {
      if (!isSqliteBusyError(error) || retries === SQLITE_BUSY_RETRY_LIMIT) throw error;
      await yieldForSqliteWriter();
    }
  }
}

/**
 * Run schema initialization once at a time for a database.
 *
 * The queueing itself is `serializeByKey` from `@makaio/storage-drizzle`. It
 * deliberately uses the same file identity as transition serialization, but
 * a distinct queue so schema setup and repository operation lifecycles remain
 * explicit.
 * @param key - Database identity the gate is keyed by.
 * @param work - Transaction body to run once the gate is free.
 * @returns Whatever `work` resolves to.
 * @typeParam TResult - Result type produced by the transaction body.
 */
async function withSchemaGate<TResult>(key: string, work: () => Promise<TResult>): Promise<TResult> {
  return serializeByKey(schemaGates, key, work);
}

/**
 * Run one test-support transaction at a time across every handle for a database file.
 * @param key - Stable database identity shared by independent file handles.
 * @param work - Complete transaction attempt, including rollback cleanup.
 * @returns Whatever the transaction resolves to.
 * @typeParam TResult - Result produced by the transaction.
 */
async function withTransactionGate<TResult>(key: string, work: () => Promise<TResult>): Promise<TResult> {
  return serializeByKey(transactionGates, key, work);
}

/**
 * Fallback gate identity for handles whose database has no file.
 *
 * Keyed on the handle the caller passed rather than on its executor: a handle
 * created by `createDatabaseClient` carries one attached executor, but an
 * unbranded handle gets a freshly synthesized executor on every
 * `getRawSqlExecutor` call, and `getRawSqlExecutor` accepts both. The handle
 * is the identity that is stable in either case.
 */
const connectionIdentities = new WeakMap<MakaioDatabase, string>();

/**
 * Resolve the identity two repository constructions must share while
 * provisioning their schema.
 *
 * The file path comes from SQLite's own `sqlite3_db_filename`, which resolves
 * a relative path against the working directory but does not resolve symlinks
 * or normalize a path otherwise. Two handles opened on the same absolute path
 * therefore share a key, while two differently-spelled paths for one file do
 * not — and neither does a second process. Both limits are out of scope: this
 * is single-process test support, and its callers open the database by one
 * spelling.
 *
 * An in-memory database has no file and is private to the connection that
 * opened it, so there the handle *is* the database.
 * @param db - Handle whose database identity is being resolved.
 * @param executor - Executor to interrogate for the database's file path.
 * @returns A stable key for the handle's `main` database.
 */
async function resolveDatabaseIdentity(db: MakaioDatabase, executor: RawSqlExecutor): Promise<string> {
  const rows = await executor.all<{ name: string; file: string | null }>(sql.raw('PRAGMA database_list'));
  const file = rows.find((row) => row.name === 'main')?.file ?? null;
  if (file !== null && file !== '') return `file:${file}`;

  const existing = connectionIdentities.get(db);
  if (existing !== undefined) return existing;
  const identity = `connection:${crypto.randomUUID()}`;
  connectionIdentities.set(db, identity);
  return identity;
}

// ─────────────────────────────────────────────────────────────
// Compare-and-set primitives
// ─────────────────────────────────────────────────────────────

/**
 * A write whose predicate repeats every guard its transition read.
 *
 * It is the only thing that decides a transition: its affected-row count says
 * whether the state the transition read was still the state it wrote against.
 */
type GuardedWrite = () => Promise<{ rowsAffected: number }>;

/**
 * Decide a transition from what its own guarded write affected.
 *
 * `read` inspects durable state and either refuses the transition or returns
 * the write that performs it. That write carries every guard `read` inspected
 * in its own predicate, so the decision derives from the affected-row count
 * rather than from the earlier read. Here `BEGIN IMMEDIATE` already prevents
 * another transaction from invalidating the read; on a store with snapshot
 * isolation it does not, and there the second `read` reports exactly the
 * refusal the loser of the race is owed.
 * @param read - Reads durable state and returns a refusal or the guarded write.
 * @param accepted - Decision reported when the guarded write applied. A
 * callback may derive it from the state that the guarded write observed.
 * @returns The refusal, or `accepted` when the write applied.
 * @throws When the write applies nothing while durable state still permits it.
 * @typeParam TDecision - Decision vocabulary of the transition.
 */
async function decideByWrite<TDecision extends { readonly kind: string }>(
  read: () => Promise<TDecision | GuardedWrite>,
  accepted: TDecision | (() => TDecision),
): Promise<TDecision> {
  const first = await read();
  if (typeof first !== 'function') return first;
  if ((await first()).rowsAffected > 0) return typeof accepted === 'function' ? accepted() : accepted;

  const contended = await read();
  if (typeof contended !== 'function') return contended;
  throw new Error('A guarded transition affected no rows while durable state still permitted it');
}

/**
 * Predicate asserting that a claim still matches durable ownership.
 * @param claim - Claim presented by the caller.
 * @returns A predicate over the claimed attempt's operation row.
 */
function claimHolds(claim: ProviderOperationClaim): SQL {
  return sql`EXISTS (SELECT 1 FROM test_provider_operation
                     WHERE execution_attempt_id = ${claim.executionAttemptId}
                       AND generation = ${claim.generation}
                       AND owner_id = ${claim.ownerId}
                       AND token = ${claim.token})`;
}

/**
 * Predicate asserting that an operation still needs ownership or recovery.
 *
 * Provider completion evidence and attempt settlement are independent durable
 * facts. The operation resolves only after both are present.
 * @param executionAttemptId - Attempt whose provider operation is constrained.
 * @returns A predicate over `test_provider_operation`'s current row.
 */
function operationIsUnresolved(executionAttemptId: string): SQL {
  return sql`(completion_evidence IS NULL
              OR NOT EXISTS (SELECT 1 FROM test_execution_attempt
                             WHERE execution_attempt_id = ${executionAttemptId}
                               AND settlement_kind IS NOT NULL))`;
}

/**
 * Predicate repeating, as part of a write, what authorization read.
 *
 * A settled attempt can still owe provider-side work, and early completion
 * evidence still needs a canonical answer. Only their combination closes an
 * operation, so neither fact alone is an authorization guard here.
 * @param claim - Claim the write is authorized by.
 * @returns A predicate that holds exactly while the claim authorizes a write.
 */
function claimAuthorizes(claim: ProviderOperationClaim): SQL {
  return sql`EXISTS (SELECT 1 FROM test_provider_operation
                     WHERE execution_attempt_id = ${claim.executionAttemptId}
                       AND generation = ${claim.generation}
                       AND owner_id = ${claim.ownerId}
                       AND token = ${claim.token}
                       AND ${operationIsUnresolved(claim.executionAttemptId)})`;
}

/**
 * Predicate asserting that an operation has confirmed its allocation ended.
 *
 * The obligation lives on the operation row while the terminal settlement
 * writes the attempt row, so the guard the settlement repeats has to reach
 * across to it.
 * @param executionAttemptId - Attempt whose operation is constrained.
 * @returns A predicate that holds exactly while the operation owes terminal convergence.
 */
function operationOwesTerminalConvergence(executionAttemptId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM test_provider_operation
                     WHERE execution_attempt_id = ${executionAttemptId}
                       AND obligation = ${'terminal-convergence'})`;
}

/**
 * Predicate asserting that an attempt row is its execution's active attempt.
 *
 * Correlated against the row being written, so it needs no execution
 * identifier from the caller and cannot be evaluated against a different row
 * than the one the write touches.
 * @returns A predicate over `test_execution_attempt`'s current row.
 */
function isActiveAttemptRow(): SQL {
  return sql`EXISTS (SELECT 1 FROM test_active_execution_attempt
                     WHERE execution_id = test_execution_attempt.execution_id
                       AND execution_attempt_id = test_execution_attempt.execution_attempt_id)`;
}

// ─────────────────────────────────────────────────────────────
// Adapter
// ─────────────────────────────────────────────────────────────

/**
 * Create a transactional SQLite realization of {@link ExecutionAttemptRepository}.
 *
 * Every decision the port defines is made inside one immediate transaction:
 * each operation reads the rows it guards on and writes its result without
 * ever leaving a partially applied transition visible. The fencing token is
 * generated here, by the repository, and never accepted from a caller.
 *
 * The adapter takes an already-open database handle and provisions its own
 * `test_`-prefixed tables, so it depends on no test harness and never touches
 * the storage migration chain. It is test support, not production
 * persistence.
 * @param db - Open database handle the repository reads and writes through.
 * @param codec - Owner-injected codec that validates and serializes outcomes.
 * @returns A repository exposing the full port surface, backed by SQLite.
 */
export async function createSqliteAttemptRepository<TOutcome>(
  db: MakaioDatabase,
  codec: OutcomeCodec<TOutcome>,
): Promise<Required<ExecutionAttemptRepository<TOutcome>>> {
  const executor = getRawSqlExecutor(db);
  // SQLite's native busy handler waits synchronously. On this Node test
  // driver that blocks the event loop before the current writer can commit,
  // so transaction acquisition below yields between immediate refusals.
  await executor.run(sql.raw('PRAGMA busy_timeout = 0'));
  const gateKey = await resolveDatabaseIdentity(db, executor);
  // Provisioning goes through the same gate as every transition, so two
  // repositories constructed concurrently over one database cannot collide on
  // the schema they both need.
  await withSchemaGate(gateKey, async () => {
    for (const statement of SCHEMA_STATEMENTS) {
      await executor.run(sql.raw(statement));
    }
    // Reference databases created before the start barrier retain their rows.
    // A missing deadline becomes null, never a newly granted bootstrap budget.
    const columns = await executor.all<{ name: string }>(sql.raw('PRAGMA table_info(test_execution_attempt)'));
    if (!columns.some((column) => column.name === 'bootstrap_deadline_at')) {
      await executor.run(sql.raw('ALTER TABLE test_execution_attempt ADD COLUMN bootstrap_deadline_at TEXT'));
    }
    // Test databases persist across repository construction in restart tests.
    // Add the positive-completion fact separately so rows created by the
    // earlier operation protocol remain open rather than being misread as
    // completed or failing to decode.
    const operationColumns = await executor.all<{ name: string }>(
      sql.raw('PRAGMA table_info(test_provider_operation)'),
    );
    if (!operationColumns.some((column) => column.name === 'completion_evidence')) {
      await executor.run(sql.raw('ALTER TABLE test_provider_operation ADD COLUMN completion_evidence TEXT'));
    }
  });

  /**
   * Set once a rollback has failed.
   *
   * A failed rollback leaves the connection's transaction state unknown, so
   * the repository is retired rather than allowed to run a later transition
   * on a connection that may still hold an open or aborted transaction.
   */
  let invalidatedBy: AggregateError | undefined;

  /**
   * Run one transition as a single transaction.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front, so a transition can
   * never read its guard under one snapshot and write its result under
   * another.
   *
   * Read-only operations run here too. That is uniformity for test support,
   * not a requirement: a durable realization serves them from a read
   * transaction instead of taking the write lock for a lookup.
   * @param work - Transition body, receiving the pinned session.
   * @returns Whatever `work` resolves to.
   * @throws When a previous transition's rollback failed.
   * @typeParam TResult - Decision type produced by the transition.
   */
  const transact = async <TResult>(work: (session: RawSqlSession) => Promise<TResult>): Promise<TResult> => {
    return serializeDatabaseOperation(db, () =>
      withTransactionGate(gateKey, async () => {
        if (invalidatedBy !== undefined) {
          throw new Error('This repository was retired by a failed transaction rollback', { cause: invalidatedBy });
        }
        for (let retries = 0; ; retries += 1) {
          try {
            return await executor.withSession(async (session) => {
              let began = false;
              try {
                await session.run(sql.raw('BEGIN IMMEDIATE'));
                began = true;
                const result = await work(session);
                await commitTransaction(session);
                return result;
              } catch (error) {
                try {
                  await session.run(sql.raw('ROLLBACK'));
                } catch (rollbackError) {
                  if (!began && isNoActiveTransactionError(rollbackError)) throw error;
                  // The connection's transaction state is now unknown, so no later
                  // transition may run on it. Reporting only the original failure
                  // would hide that.
                  invalidatedBy = new AggregateError([error, rollbackError], 'Transaction rollback failed');
                  throw invalidatedBy;
                }
                throw error;
              }
            });
          } catch (error) {
            if (!isSqliteBusyError(error) || retries === SQLITE_BUSY_RETRY_LIMIT) throw error;
            await yieldForSqliteWriter();
          }
        }
      }),
    );
  };

  /**
   * Read one attempt row.
   * @param session - Session inside the current transaction.
   * @param executionAttemptId - Attempt to read.
   * @returns The stored row, or `undefined` when no such attempt exists.
   */
  const readAttemptRow = async (session: RawSqlSession, executionAttemptId: string): Promise<AttemptRow | undefined> =>
    (
      await session.all<AttemptRow>(
        sql`SELECT * FROM test_execution_attempt WHERE execution_attempt_id = ${executionAttemptId}`,
      )
    )[0];

  /**
   * Read one provider-operation row.
   * @param session - Session inside the current transaction.
   * @param executionAttemptId - Attempt whose operation to read.
   * @returns The stored row, or `undefined` when provisioning never began.
   */
  const readOperationRow = async (
    session: RawSqlSession,
    executionAttemptId: string,
  ): Promise<OperationRow | undefined> =>
    (
      await session.all<OperationRow>(
        sql`SELECT * FROM test_provider_operation WHERE execution_attempt_id = ${executionAttemptId}`,
      )
    )[0];

  /**
   * Whether the attempt's allocation is durably confirmed to have ended.
   *
   * Termination is recorded on the operation row before the attempt settles,
   * so between those two writes the attempt still carries its allocation
   * reference while nothing can run on it anymore. Registration and admission
   * read the obligation for that reason, and their writes repeat it through
   * `operationOwesTerminalConvergence`.
   * @param session - Session inside the current transaction.
   * @param executionAttemptId - Attempt whose operation to inspect.
   * @returns True when the allocation's termination was recorded.
   */
  const allocationTerminated = async (session: RawSqlSession, executionAttemptId: string): Promise<boolean> =>
    (await readOperationRow(session, executionAttemptId))?.obligation === 'terminal-convergence';

  /**
   * Read which attempt is currently active for an execution.
   * @param session - Session inside the current transaction.
   * @param executionId - Execution whose pointer to read.
   * @returns The active attempt identifier, or `null` when none is set.
   */
  const readActiveAttemptId = async (session: RawSqlSession, executionId: string): Promise<string | null> => {
    const rows = await session.all<ActiveAttemptRow>(
      sql`SELECT execution_attempt_id FROM test_active_execution_attempt WHERE execution_id = ${executionId}`,
    );
    return rows[0]?.execution_attempt_id ?? null;
  };

  /**
   * Read common runtime reachability before decoding any control columns.
   * Reads remain staged: settlement skips the owner lookup and fencing skips
   * the allocation lookup. The caller's transaction owns their consistency.
   * @param session - Session inside the current transaction.
   * @param row - Existing attempt already matched to the requested owner.
   * @returns The first common refusal, or null to decode and evaluate control.
   */
  const runtimeReachability = async (
    session: RawSqlSession,
    row: AttemptRow,
  ): Promise<AttemptReachabilityDecision | null> => {
    const settled = row.settlement_kind !== null;
    const active = !settled && (await readActiveAttemptId(session, row.execution_id)) === row.execution_attempt_id;
    return evaluateAttemptReachability({
      matchesExecution: true,
      settled,
      active,
      allocated:
        active && row.allocation_ref !== null && !(await allocationTerminated(session, row.execution_attempt_id)),
    });
  };

  /**
   * Result of authorizing a claim against the stored operation row.
   *
   * `authorized` carries both records so a transition never re-reads them,
   * and the three refusal kinds map straight onto the shared decision
   * vocabulary.
   */
  type ClaimAuthorization =
    | {
        readonly kind: 'authorized';
        readonly attempt: ExecutionAttemptRecord;
        readonly attemptRow: AttemptRow;
        readonly operation: OperationRow;
      }
    | { readonly kind: 'stale'; readonly attempt: ExecutionAttemptRecord }
    | { readonly kind: 'resolved'; readonly attempt: ExecutionAttemptRecord }
    | { readonly kind: 'not-found' };

  /**
   * The refusals every claim-fenced transition shares, in the narrowest form
   * that every claim-fenced decision vocabulary accepts.
   */
  type ClaimRefusal = { readonly kind: 'stale' | 'resolved' | 'not-found' };

  /**
   * Authorize a claim against durable ownership.
   *
   * Lease expiry is deliberately not part of authorization: an expired lease
   * only enables takeover, and takeover is what actually fences the previous
   * owner by advancing the generation and reissuing the token.
   * @param session - Session inside the current transaction.
   * @param claim - Claim presented by the caller.
   * @returns The narrowed records, or the refusal to report.
   */
  const authorize = async (session: RawSqlSession, claim: ProviderOperationClaim): Promise<ClaimAuthorization> => {
    const attemptRow = await readAttemptRow(session, claim.executionAttemptId);
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
  };

  /**
   * Map an unauthorized claim onto the refusal every claim-fenced transition
   * shares.
   * @param session - Session inside the current transaction.
   * @param claim - Claim presented by the caller.
   * @returns The refusal to report, or `undefined` when the claim authorizes.
   */
  const refuseUnauthorized = async (
    session: RawSqlSession,
    claim: ProviderOperationClaim,
  ): Promise<ClaimRefusal | undefined> => {
    const authorization = await authorize(session, claim);
    return authorization.kind === 'authorized' ? undefined : { kind: authorization.kind };
  };

  /**
   * Settle an attempt without inferring provider-operation completion.
   *
   * The terminal transition is the settlement itself: it applies only while
   * the attempt is unsettled and `guard` still holds, which is what makes the
   * first terminal writer the winner and every later one a loser that changes
   * nothing. A settled attempt may still leave an owned operation behind, so
   * the provider operation stays open until a caller records positive completion
   * evidence. Pre-allocation absence and process-loss proofs are the narrow
   * exceptions: their callers write both facts atomically with the dedicated
   * helper below.
   * @param session - Session inside the current transaction.
   * @param executionAttemptId - Attempt reaching a terminal state.
   * @param settlementKind - How the attempt reached that state.
   * @param guard - Transition-specific predicate the attempt row must satisfy.
   * @returns The settlement write's affected-row count.
   */
  const settleAttempt = async (
    session: RawSqlSession,
    executionAttemptId: string,
    settlementKind: NonNullable<ExecutionAttemptSettlementKind>,
    guard: SQL,
  ): Promise<{ rowsAffected: number }> => {
    const settled = await session.run(
      // The start gate closes with the settlement. The active operation is
      // deliberately left in place, so a completion arriving after this reads
      // `resolved` rather than `not-active`.
      sql`UPDATE test_execution_attempt
          SET status = ${'settled'}, settlement_kind = ${settlementKind}, claimable = ${0},
              operation_start_gate = ${'closed'}
          WHERE execution_attempt_id = ${executionAttemptId}
            AND settlement_kind IS NULL
            AND ${guard}`,
    );
    if (settled.rowsAffected === 0) return settled;
    return settled;
  };

  /**
   * Settle a pre-allocation attempt and persist its provider completion proof.
   *
   * Positive absence and process-bound provisioner loss prove both facts at
   * once: no allocation exists, and no provider-side responsibility remains.
   * An earlier positive proof is immutable, so a later abandonment preserves
   * it rather than attempting to replace it. Resolution retains the final
   * control snapshot rather than clearing it like a handoff; that snapshot
   * does not identify the writer of an earlier proof.
   * @param session - Session inside the current transaction.
   * @param executionAttemptId - Attempt reaching abandonment.
   * @param claim - Current claim retained as the final control snapshot.
   * @param guard - Transition-specific predicate the attempt row must satisfy.
   * @param evidence - Positive proof shared by settlement and completion.
   * @param alreadySettled - Whether the proof completes an existing settlement.
   * @returns A positive count when this invocation durably completed its
   * transition; an existing settlement must still write the missing proof.
   */
  const settleAndCompletePreallocationOperation = async (
    session: RawSqlSession,
    executionAttemptId: string,
    claim: ProviderOperationClaim,
    guard: SQL,
    evidence: BoundedRecoveryEvidence,
    alreadySettled: boolean,
  ): Promise<{ rowsAffected: number }> => {
    if (!alreadySettled) {
      const settled = await settleAttempt(session, executionAttemptId, 'abandoned', guard);
      if (settled.rowsAffected === 0) return settled;
      const proof = await session.run(
        sql`UPDATE test_provider_operation
              SET completion_evidence = ${JSON.stringify(evidence)}
              WHERE execution_attempt_id = ${executionAttemptId}
                AND ${claimHolds(claim)}
                AND completion_evidence IS NULL`,
      );
      if (proof.rowsAffected === 0) {
        const operation = await readOperationRow(session, executionAttemptId);
        if (operation?.completion_evidence === null) {
          throw new Error('Pre-allocation settlement succeeded without provider completion evidence');
        }
      }
      return settled;
    }
    return session.run(
      sql`UPDATE test_provider_operation
            SET completion_evidence = ${JSON.stringify(evidence)}
            WHERE execution_attempt_id = ${executionAttemptId}
              AND ${claimHolds(claim)}
              AND completion_evidence IS NULL`,
    );
  };

  /**
   * Record an allocation reference against a claimed operation.
   *
   * The initial-provisioning path and the discovery path converge here; they
   * differ only in whether the attempt may become bootstrap-claimable. An
   * attempt that is no longer the active attempt for its execution never
   * becomes claimable on either path.
   * @param input - Claim and the allocation reference to store.
   * @param bootstrapClaimable - Whether this path may mark the attempt bootstrap-claimable.
   * @returns The durable allocation decision.
   * @throws When the reference names a provider other than the attempt's own.
   */
  const applyAllocation = (
    input: RecordAllocationInput,
    bootstrapClaimable: boolean,
  ): Promise<AllocationRecordingDecision> => {
    const allocationRef = parseAllocationRef(input.allocationRef);
    // Claimability is decided by the write, correlated against the row it
    // touches, so an attempt cannot be superseded between the check and the
    // flag being set.
    const claimable = bootstrapClaimable
      ? sql`CASE WHEN settlement_kind IS NULL AND ${isActiveAttemptRow()} THEN 1 ELSE 0 END`
      : sql`${0}`;
    return transact((session) =>
      decideByWrite<AllocationRecordingDecision>(
        async () => {
          const authorization = await authorize(session, input.claim);
          // The binding is a fact about the attempt, so it is judged as soon
          // as the attempt is known and before any decision about the caller
          // is reported.
          if (authorization.kind !== 'not-found') requireAllocationRefProvider(authorization.attempt, allocationRef);
          if (authorization.kind === 'resolved') {
            return { kind: 'resolved', allocationRef: authorization.attempt.allocationRef };
          }
          if (authorization.kind !== 'authorized') return { kind: authorization.kind };
          const { attempt } = authorization;

          if (attempt.allocationRef !== null) {
            return sameAllocationRef(attempt.allocationRef, allocationRef)
              ? { kind: 'duplicate', allocationRef: attempt.allocationRef }
              : { kind: 'conflict', allocationRef: attempt.allocationRef };
          }

          return async () => {
            const applied = await session.run(
              sql`UPDATE test_execution_attempt
                SET status = CASE WHEN settlement_kind IS NULL THEN ${'allocated'} ELSE status END,
                    allocation_ref = ${JSON.stringify(allocationRef)},
                    claimable = ${claimable}
                WHERE execution_attempt_id = ${attempt.executionAttemptId}
                  AND allocation_ref IS NULL
                  AND ${claimAuthorizes(input.claim)}`,
            );
            if (applied.rowsAffected === 0) return applied;
            await session.run(
              sql`UPDATE test_provider_operation SET obligation = ${'allocation-control'}
                WHERE execution_attempt_id = ${attempt.executionAttemptId}`,
            );
            return applied;
          };
        },
        { kind: 'recorded' },
      ),
    );
  };

  /**
   * The coherent recovery capability, implemented in full.
   *
   * The port offers recovery whole or not at all, so the four transitions are
   * one object here too rather than four members a realization could get
   * three-quarters right.
   */
  const recovery: ExecutionAttemptRecoveryOperations = {
    async getAttemptWithAllocation(executionAttemptId: string): Promise<ExecutionAttemptRecord | null> {
      return transact(async (session) => {
        const row = await readAttemptRow(session, executionAttemptId);
        return row === undefined ? null : toAttemptRecord(row);
      });
    },

    async recordDiscoveredAllocation(input: RecordAllocationInput): Promise<DiscoveredAllocationDecision> {
      return applyAllocation(input, false);
    },

    async evolveAllocationRef(input: AllocationRefEvolution): Promise<AllocationRefEvolutionDecision> {
      const { currentRef, nextRef } = parseAllocationRefEvolution(input);
      return transact((session) =>
        decideByWrite<AllocationRefEvolutionDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind === 'stale') {
              return { kind: 'stale', storedRef: authorization.attempt.allocationRef };
            }
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt, attemptRow } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.allocationRef === null) return { kind: 'not-allocated' };
            // The port's own value equality decides whether the caller's view
            // is current; the stored serialization below decides whether
            // anything changed since this transaction read it. They answer
            // different questions, and only the second one is the concurrency
            // guard — which is why it may be spelled in whatever way the store
            // proves an unchanged row.
            if (!sameAllocationRef(attempt.allocationRef, currentRef)) {
              return { kind: 'stale', storedRef: attempt.allocationRef };
            }

            return () =>
              session.run(
                sql`UPDATE test_execution_attempt SET allocation_ref = ${JSON.stringify(nextRef)}
                  WHERE execution_attempt_id = ${attempt.executionAttemptId}
                    AND execution_id = ${input.executionId}
                    AND allocation_ref = ${attemptRow.allocation_ref}
                    AND ${claimAuthorizes(input.claim)}`,
              );
          },
          { kind: 'evolved' },
        ),
      );
    },

    async getRecoverableAttempts(executionId: string): Promise<readonly RecoverableAttemptRecord[]> {
      return transact(async (session) => {
        const now = new Date().toISOString();
        // The port reports oldest first, ties broken by identifier. `created_at`
        // is stored in the canonical UTC millisecond form, so ordering the
        // column lexicographically is ordering the instants.
        const rows = await session.all<AttemptRow>(
          sql`SELECT * FROM test_execution_attempt
              WHERE execution_id = ${executionId}
                AND status = ${'allocated'}
                AND settlement_kind IS NULL
                AND allocation_ref IS NOT NULL
                AND claimable = ${1}
                AND (claim_expires_at IS NULL OR claim_expires_at >= ${now})
              ORDER BY created_at ASC, execution_attempt_id ASC`,
        );
        return rows.map((row) => toRecoverableAttempt(toAttemptRecord(row)));
      });
    },

    async listOpenProviderOperations(
      input: ListOpenProviderOperationsInput,
    ): Promise<readonly OpenProviderOperationRecord[]> {
      const observedAt = normalizeInstant(input.observedAt);
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new RangeError('Provider-operation recovery limit must be a positive safe integer');
      }
      return transact(async (session) => {
        const rows = await session.all<AttemptRow & OperationRow>(
          sql`SELECT attempt.*, operation.generation, operation.owner_id, operation.token, operation.lease_expires_at,
                     operation.obligation, operation.failure_count, operation.last_failure, operation.completion_evidence
                FROM test_execution_attempt AS attempt
                INNER JOIN test_provider_operation AS operation
                  ON operation.execution_attempt_id = attempt.execution_attempt_id
                WHERE (operation.completion_evidence IS NULL OR attempt.settlement_kind IS NULL)
                  AND (
                    operation.owner_id IS NULL
                    OR operation.lease_expires_at IS NULL
                    OR operation.lease_expires_at <= ${observedAt}
                  )
                ORDER BY attempt.created_at ASC, attempt.execution_attempt_id ASC
                LIMIT ${input.limit}`,
        );
        return rows.map((row) => ({ attempt: toAttemptRecord(row), operation: toOperationRecord(row) }));
      });
    },
  };

  /**
   * Insert and fence within the caller's existing transaction.
   * @param session - Session owning the atomic creation and optional request binding.
   * @param input - Snapshotted creation fields.
   * @param timing - First-acceptance timestamps, never calculated for replay.
   * @returns The newly persisted attempt.
   */
  const createAttemptInSession = async (
    session: RawSqlSession,
    input: ExecutionAttemptCreate,
    timing: ReturnType<typeof createAttemptTiming>,
  ): Promise<ExecutionAttemptRecord> => {
    const { instruction } = input;
    const { createdAt, bootstrapDeadlineAt } = timing;
    // The primary key is what rejects a reused attempt identifier. The
    // port makes that a caller bug precisely so no implementation has to
    // choose between overwriting a possibly settled attempt and silently
    // ignoring the call. Letting the store decide is the race-free way to
    // detect it, so the constraint violation is translated into the port's
    // own error rather than a caller having to recognize driver text.
    try {
      await session.run(
        sql`INSERT INTO test_execution_attempt
                (execution_attempt_id, execution_id, instruction, status, claimable, created_at, bootstrap_deadline_at)
              VALUES (${input.executionAttemptId}, ${input.executionId}, ${JSON.stringify(instruction)}, ${'pending'}, ${0}, ${createdAt}, ${bootstrapDeadlineAt})`,
      );
    } catch (error) {
      if (!isSqliteUniqueViolationError(error)) throw error;
      throw new DuplicateExecutionAttemptError(input.executionAttemptId, { cause: error });
    }
    // The pointer moves in the same transaction as the insert. An
    // allocated attempt it replaces loses bootstrap eligibility, but its
    // host-owned claim expiry remains an immutable record of that window.
    await session.run(
      sql`UPDATE test_execution_attempt
              SET claimable = ${0}
              WHERE execution_attempt_id = (
                SELECT execution_attempt_id
                FROM test_active_execution_attempt
                WHERE execution_id = ${input.executionId}
              )
                AND status = ${'allocated'}`,
    );
    // The superseded attempt's gate closes in this same transaction. One
    // that stayed open could admit an operation between the pointer move
    // and any later cleanup, which is work begun on an attempt nobody
    // addresses any more.
    await session.run(
      sql`UPDATE test_execution_attempt
              SET operation_start_gate = ${'closed'}
              WHERE execution_attempt_id = (
                SELECT execution_attempt_id
                FROM test_active_execution_attempt
                WHERE execution_id = ${input.executionId}
              )`,
    );
    await session.run(
      sql`INSERT INTO test_active_execution_attempt (execution_id, execution_attempt_id)
              VALUES (${input.executionId}, ${input.executionAttemptId})
              ON CONFLICT(execution_id)
              DO UPDATE SET execution_attempt_id = excluded.execution_attempt_id`,
    );
    return {
      ...INITIAL_ATTEMPT_CONTROL_STATE,
      executionAttemptId: input.executionAttemptId,
      executionId: input.executionId,
      instruction,
      preparationReceipts: Object.freeze([]),
      status: 'pending',
      allocationRef: null,
      createdAt,
      bootstrapDeadlineAt,
      providerId: null,
      allocationLifetime: null,
      provisionerIncarnationId: null,
      settlementKind: null,
      claimable: false,
      claimExpiresAt: null,
    };
  };

  return {
    async createAttempt(input: ExecutionAttemptCreate): Promise<ExecutionAttemptRecord> {
      const snapshot = { ...input, instruction: parseInstruction(input.instruction) };
      const timing = createAttemptTiming(input.bootstrapTimeoutMs);
      return transact((session) => createAttemptInSession(session, snapshot, timing));
    },

    async ensureAttempt(input: EnsureExecutionAttemptPersistenceInput): Promise<EnsureExecutionAttemptDecision> {
      const snapshot = snapshotEnsureExecutionAttemptPersistenceInput(input);
      return transact(async (session) => {
        const bindings = await session.all<ActiveAttemptRow>(
          sql`SELECT execution_attempt_id FROM test_execution_attempt_request
              WHERE execution_id = ${snapshot.executionId} AND request_key = ${snapshot.requestKey}`,
        );
        const binding = bindings[0];
        if (binding !== undefined) {
          const row = await readAttemptRow(session, binding.execution_attempt_id);
          return replayEnsuredAttempt(snapshot, row === undefined ? null : toAttemptRecord(row));
        }
        const attempt = await createAttemptInSession(
          session,
          snapshot,
          createAttemptTiming(snapshot.bootstrapTimeoutMs),
        );
        await session.run(
          sql`INSERT INTO test_execution_attempt_request (execution_id, request_key, execution_attempt_id)
              VALUES (${snapshot.executionId}, ${snapshot.requestKey}, ${attempt.executionAttemptId})`,
        );
        return { kind: 'created', attempt: structuredClone(attempt) };
      });
    },

    async readAttemptSettlement(input: ReadAttemptSettlementInput): Promise<AttemptSettlementRead<TOutcome>> {
      const snapshot = snapshotReadAttemptSettlementInput(input);
      return transact(async (session) => {
        const row = await readAttemptRow(session, snapshot.executionAttemptId);
        if (row === undefined || row.execution_id !== snapshot.executionId) return { kind: 'not-found' };
        return readAttemptSettlementSnapshot(
          snapshot,
          {
            attempt: toAttemptRecord(row),
            activeAttemptId: await readActiveAttemptId(session, snapshot.executionId),
            outcomeText: row.workflow_result,
          },
          codec,
        );
      });
    },

    async readBootstrapStartState(input: ReadBootstrapStartStateInput): Promise<BootstrapStartState | null> {
      return transact(async (session) => {
        const row = await readAttemptRow(session, input.executionAttemptId);
        if (row === undefined || row.execution_id !== input.executionId) return null;
        return {
          settled: row.settlement_kind !== null,
          active: (await readActiveAttemptId(session, input.executionId)) === input.executionAttemptId,
          allocated: row.allocation_ref !== null,
          allocationTerminated: await allocationTerminated(session, input.executionAttemptId),
          operationStartGate: parseMember(
            ATTEMPT_OPERATION_START_GATES,
            row.operation_start_gate,
            'operation_start_gate',
          ),
          bootstrapDeadlineAt: row.bootstrap_deadline_at,
        };
      });
    },

    async beginProvisioning(input: BeginProvisioningInput): Promise<ProvisioningClaimDecision> {
      const allocationLifetime = parseAllocationLifetime(input.allocationLifetime);
      // Issued once, before the decision, so a contended re-read can never
      // hand a second caller a different token for the same `started`.
      const claim: ProviderOperationClaim = {
        executionAttemptId: input.executionAttemptId,
        generation: 1,
        ownerId: input.ownerId,
        token: crypto.randomUUID(),
        leaseExpiresAt: normalizeInstant(input.leaseExpiresAt),
      };
      return transact((session) =>
        decideByWrite<ProvisioningClaimDecision>(
          async () => {
            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
            const attempt = toAttemptRecord(attemptRow);
            const activeAttemptId = await readActiveAttemptId(session, input.executionId);
            if (activeAttemptId !== input.executionAttemptId) return { kind: 'fenced' };
            if (attempt.settlementKind != null) return { kind: 'resolved', allocationRef: attempt.allocationRef };
            if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };
            if (attempt.status !== 'pending') return { kind: 'already-provisioning' };

            // One transaction: bind the provider immutably and open the
            // operation. `status = 'pending'` in the predicate is what makes
            // begin succeed at most once per attempt.
            return async () => {
              const applied = await session.run(
                sql`UPDATE test_execution_attempt
                  SET status = ${'provisioning'},
                      provider_id = ${input.providerId},
                      allocation_lifetime = ${allocationLifetime},
                      provisioner_incarnation_id = ${input.provisionerIncarnationId}
                  WHERE execution_attempt_id = ${input.executionAttemptId}
                    AND execution_id = ${input.executionId}
                    AND status = ${'pending'}
                    AND allocation_ref IS NULL
                    AND settlement_kind IS NULL
                    AND ${isActiveAttemptRow()}`,
              );
              if (applied.rowsAffected === 0) return applied;
              await session.run(
                sql`INSERT INTO test_provider_operation
                    (execution_attempt_id, generation, owner_id, token, lease_expires_at, obligation, failure_count)
                  VALUES (${input.executionAttemptId}, ${claim.generation}, ${claim.ownerId}, ${claim.token},
                          ${claim.leaseExpiresAt}, ${'provisioning-resolution'}, ${0})`,
              );
              return applied;
            };
          },
          { kind: 'started', claim },
        ),
      );
    },

    async getProviderOperation(executionAttemptId: string): Promise<ProviderOperationOwnershipRecord | null> {
      return transact(async (session) => {
        const row = await readOperationRow(session, executionAttemptId);
        return row === undefined ? null : toOperationRecord(row);
      });
    },

    async renewProviderOperationClaim(
      input: RenewProviderOperationClaimInput,
    ): Promise<ProviderOperationClaimDecision> {
      // Renewal keeps generation and token: extending a lease fences nobody.
      const leaseExpiresAt = normalizeInstant(input.leaseExpiresAt);
      return transact((session) =>
        decideByWrite<ProviderOperationClaimDecision>(
          async () =>
            (await refuseUnauthorized(session, input.claim)) ??
            (() =>
              session.run(
                sql`UPDATE test_provider_operation SET lease_expires_at = ${leaseExpiresAt}
                    WHERE execution_attempt_id = ${input.claim.executionAttemptId}
                      AND ${claimAuthorizes(input.claim)}`,
              )),
          { kind: 'claimed', claim: { ...input.claim, leaseExpiresAt } },
        ),
      );
    },

    async takeOverProviderOperation(input: TakeOverProviderOperationInput): Promise<ProviderOperationClaimDecision> {
      return transact(async (session) => {
        const attemptRow = await readAttemptRow(session, input.executionAttemptId);
        const operation = await readOperationRow(session, input.executionAttemptId);
        if (attemptRow === undefined || operation === undefined) return { kind: 'not-found' };
        const attempt = toAttemptRecord(attemptRow);
        if (isProviderOperationResolved(attempt, toOperationRecord(operation))) return { kind: 'resolved' };
        const observedAt = normalizeInstant(input.observedAt);
        const held =
          operation.owner_id !== null &&
          operation.lease_expires_at !== null &&
          instantOf(operation.lease_expires_at) > instantOf(observedAt);
        if (held) return { kind: 'stale' };

        const claim: ProviderOperationClaim = {
          executionAttemptId: input.executionAttemptId,
          generation: operation.generation + 1,
          ownerId: input.ownerId,
          token: crypto.randomUUID(),
          leaseExpiresAt: normalizeInstant(input.leaseExpiresAt),
        };
        // The generation guard makes takeover a compare-and-set: a second
        // taker that read the same row updates nothing and is refused. The
        // derived-resolution guard closes the same race against the independent
        // settlement and evidence facts; either fact alone leaves the operation
        // eligible for takeover.
        const { rowsAffected } = await session.run(
          sql`UPDATE test_provider_operation
              SET generation = ${claim.generation}, owner_id = ${claim.ownerId}, token = ${claim.token},
                  lease_expires_at = ${claim.leaseExpiresAt}
              WHERE execution_attempt_id = ${input.executionAttemptId}
                AND generation = ${operation.generation}
                AND ${operationIsUnresolved(input.executionAttemptId)}`,
        );
        if (rowsAffected === 0) {
          const latestAttempt = await readAttemptRow(session, input.executionAttemptId);
          const latestOperation = await readOperationRow(session, input.executionAttemptId);
          return latestAttempt !== undefined &&
            latestOperation !== undefined &&
            isProviderOperationResolved(toAttemptRecord(latestAttempt), toOperationRecord(latestOperation))
            ? { kind: 'resolved' }
            : { kind: 'stale' };
        }
        return { kind: 'claimed', claim };
      });
    },

    async handoffProviderOperation(input: HandoffProviderOperationInput): Promise<ProviderOperationMutationDecision> {
      // Generation and obligation survive; clearing the token fences the
      // released claim immediately so takeover need not await the old lease.
      const evidence = input.evidence === undefined ? null : BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact((session) =>
        decideByWrite<ProviderOperationMutationDecision>(
          async () =>
            (await refuseUnauthorized(session, input.claim)) ??
            (() =>
              session.run(
                evidence === null
                  ? sql`UPDATE test_provider_operation
                        SET owner_id = NULL, token = NULL, lease_expires_at = NULL
                        WHERE execution_attempt_id = ${input.claim.executionAttemptId}
                          AND ${claimAuthorizes(input.claim)}`
                  : sql`UPDATE test_provider_operation
                        SET owner_id = NULL, token = NULL, lease_expires_at = NULL,
                            last_failure = ${JSON.stringify(evidence)}
                        WHERE execution_attempt_id = ${input.claim.executionAttemptId}
                          AND ${claimAuthorizes(input.claim)}`,
              )),
          { kind: 'recorded' },
        ),
      );
    },

    async recordProviderOperationUncertainty(
      input: RecordProviderOperationUncertaintyInput,
    ): Promise<ProviderOperationMutationDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact((session) =>
        decideByWrite<ProviderOperationMutationDecision>(
          async () =>
            (await refuseUnauthorized(session, input.claim)) ??
            (() =>
              session.run(
                sql`UPDATE test_provider_operation
                    SET failure_count = failure_count + 1, last_failure = ${JSON.stringify(evidence)}
                    WHERE execution_attempt_id = ${input.claim.executionAttemptId}
                      AND ${claimAuthorizes(input.claim)}`,
              )),
          { kind: 'recorded' },
        ),
      );
    },

    async completeProviderOperation(
      input: CompleteProviderOperationInput,
    ): Promise<ProviderOperationCompletionDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact(async (session) => {
        const attemptRow = await readAttemptRow(session, input.claim.executionAttemptId);
        const operation = await readOperationRow(session, input.claim.executionAttemptId);
        if (attemptRow === undefined || operation === undefined) return { kind: 'not-found' };
        const claimMatches =
          operation.generation === input.claim.generation &&
          operation.owner_id === input.claim.ownerId &&
          operation.token === input.claim.token;
        // Provenance fencing deliberately precedes idempotence: completion by
        // another controller is not evidence that this controller completed it.
        if (!claimMatches) return { kind: 'stale' };
        const attempt = toAttemptRecord(attemptRow);
        if (isProviderOperationResolved(attempt, toOperationRecord(operation))) return { kind: 'already-completed' };
        if (operation.completion_evidence !== null) return { kind: 'evidence-recorded' };

        const recorded = await session.run(
          sql`UPDATE test_provider_operation
                SET completion_evidence = ${JSON.stringify(evidence)}
                WHERE execution_attempt_id = ${input.claim.executionAttemptId}
                  AND ${claimHolds(input.claim)}
                  AND completion_evidence IS NULL`,
        );
        if (recorded.rowsAffected > 0) {
          const latestAttempt = await readAttemptRow(session, input.claim.executionAttemptId);
          if (latestAttempt === undefined) return { kind: 'not-found' };
          return latestAttempt.settlement_kind === null ? { kind: 'evidence-recorded' } : { kind: 'completed' };
        }

        const latestAttempt = await readAttemptRow(session, input.claim.executionAttemptId);
        const latestOperation = await readOperationRow(session, input.claim.executionAttemptId);
        if (latestAttempt === undefined || latestOperation === undefined) return { kind: 'not-found' };
        const latestClaimMatches =
          latestOperation.generation === input.claim.generation &&
          latestOperation.owner_id === input.claim.ownerId &&
          latestOperation.token === input.claim.token;
        if (!latestClaimMatches) return { kind: 'stale' };
        if (isProviderOperationResolved(toAttemptRecord(latestAttempt), toOperationRecord(latestOperation))) {
          return { kind: 'already-completed' };
        }
        if (latestOperation.completion_evidence !== null) return { kind: 'evidence-recorded' };
        return { kind: 'stale' };
      });
    },

    async recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision> {
      return applyAllocation(input, true);
    },

    async recordProvisioningAbsent(input: RecordProvisioningAbsentInput): Promise<ProvisioningAbsenceDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      let preservedSettlement = false;
      return transact((session) =>
        decideByWrite<ProvisioningAbsenceDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };
            preservedSettlement = attempt.settlementKind !== null;

            return () =>
              settleAndCompletePreallocationOperation(
                session,
                attempt.executionAttemptId,
                input.claim,
                sql`execution_id = ${input.executionId}
                  AND allocation_ref IS NULL
                  AND ${claimHolds(input.claim)}`,
                evidence,
                preservedSettlement,
              );
          },
          () => (preservedSettlement ? { kind: 'completed' } : { kind: 'recorded' }),
        ),
      );
    },

    async recordProvisionerIncarnationLost(
      input: RecordProvisionerIncarnationLostInput,
    ): Promise<ProvisionerIncarnationLossDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.proof.evidence);
      let preservedSettlement = false;
      return transact((session) =>
        decideByWrite<ProvisionerIncarnationLossDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt } = authorization;
            const refusal = evaluateProvisionerIncarnationLoss(attempt, input);
            if (refusal !== null) return refusal;
            preservedSettlement = attempt.settlementKind !== null;

            // Both immutable facts are repeated in the predicate, so the write
            // applies only against the very attempt the proof was judged
            // against — never against one a concurrent transition reshaped.
            return () =>
              settleAndCompletePreallocationOperation(
                session,
                attempt.executionAttemptId,
                input.claim,
                sql`execution_id = ${input.executionId}
                  AND allocation_ref IS NULL
                  AND allocation_lifetime = ${'provisioner-process-bound'}
                  AND provisioner_incarnation_id = ${input.proof.provisionerIncarnationId}
                  AND ${claimHolds(input.claim)}`,
                evidence,
                preservedSettlement,
              );
          },
          () => (preservedSettlement ? { kind: 'completed' } : { kind: 'recorded' }),
        ),
      );
    },

    async recordAllocationTerminated(input: RecordAllocationTerminatedInput): Promise<AllocationTerminationDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact((session) =>
        decideByWrite<AllocationTerminationDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt } = authorization;
            // Termination is only meaningful for a known allocation. Reporting
            // that distinctly is what keeps a fenced controller distinguishable
            // from a current one that simply has nothing to terminate.
            if (attempt.allocationRef === null) return { kind: 'not-allocated' };

            // The obligation is derived from the transition, never supplied by
            // the caller. Terminal convergence is the last obligation, so
            // writing it is inherently one-way: no transition anywhere writes a
            // lower one.
            return () =>
              session.run(
                sql`UPDATE test_provider_operation
                  SET obligation = ${'terminal-convergence'}, last_failure = ${JSON.stringify(evidence)}
                  WHERE execution_attempt_id = ${attempt.executionAttemptId}
                    AND ${claimAuthorizes(input.claim)}
                    AND EXISTS (SELECT 1 FROM test_execution_attempt
                                WHERE execution_attempt_id = ${attempt.executionAttemptId}
                                  AND allocation_ref IS NOT NULL)`,
              );
          },
          { kind: 'recorded' },
        ),
      );
    },

    async recordInfrastructureFailure(input: RecordInfrastructureFailureInput): Promise<InfrastructureFailureDecision> {
      return transact((session) =>
        decideByWrite<InfrastructureFailureDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt, operation } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.settlementKind !== null) return { kind: 'resolved' };
            if (attempt.allocationRef === null) return { kind: 'not-allocated' };
            // Terminal settlement is irreversible, so it may only follow the
            // durable evidence that the allocation actually ended. An
            // operation still owing allocation control has not recorded that
            // evidence yet. The stored value is narrowed rather than compared
            // raw, so corruption fails loudly instead of reading as a refusal.
            const obligation = parseMember(PROVIDER_OPERATION_OBLIGATIONS, operation.obligation, 'obligation');
            if (obligation !== 'terminal-convergence') return { kind: 'not-terminated' };

            return () =>
              settleAttempt(
                session,
                attempt.executionAttemptId,
                'infrastructure-failure',
                sql`execution_id = ${input.executionId}
                  AND allocation_ref IS NOT NULL
                  AND ${operationOwesTerminalConvergence(attempt.executionAttemptId)}
                  AND ${claimHolds(input.claim)}`,
              );
          },
          { kind: 'recorded' },
        ),
      );
    },

    async registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRegistrationDecision> {
      return transact(async (session) => {
        // The generation the write allocates is one past the one it pins in its
        // own predicate, so it exists only once the read has run. It is read
        // back below solely on the branch where that write applied.
        let allocatedGeneration = 0;
        const decision = await decideByWrite<RuntimeRegistrationDecision | { readonly kind: 'applied' }>(
          async () => {
            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
            const unreachable = await runtimeReachability(session, attemptRow);
            if (unreachable !== null) return unreachable;
            const control = decodeAttemptControlState(attemptRow);
            const refusal = evaluateRuntimeRegistration(control, input);
            if (refusal !== null) return refusal;

            allocatedGeneration = control.runtimeGeneration + 1;
            // The monotonic-counter compare-and-set: pinning the generation the
            // read saw is what makes two racing registrations advance it once.
            // Readiness is cleared with it — it belonged to the incarnation
            // this one replaces — and so is an orphaned probe, all five
            // members in the one statement. The predicate admits only an idle
            // slot or a probe, never a workload operation.
            return () =>
              session.run(
                sql`UPDATE test_execution_attempt
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
    },

    async admitOperation(input: AdmitOperationInput): Promise<OperationAdmissionDecision> {
      // Minted before the decision, so a contended re-read can never hand a
      // second caller a different identifier for the same admission. The
      // instant is minted with it, because it is stored with the operation and
      // reported unchanged to every replay.
      const operationId = crypto.randomUUID();
      const admittedAt = normalizeInstant(new Date().toISOString());
      // The bounded probe is the one kind admitted while readiness is unproven:
      // it is what proves it, so requiring readiness of it would make readiness
      // unreachable.
      const requiresReadiness = input.operationKind !== 'runtime-probe';
      const readinessGuard: SQL = requiresReadiness ? sql`runtime_ready_at IS NOT NULL` : sql`1 = 1`;
      return transact((session) =>
        decideByWrite<OperationAdmissionDecision>(
          async () => {
            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
            const unreachable = await runtimeReachability(session, attemptRow);
            if (unreachable !== null) return unreachable;
            const control = decodeAttemptControlState(attemptRow);
            const refusal = evaluateOperationAdmission(control, input, admittedAt, toAttemptRecord(attemptRow));
            if (refusal !== null) return refusal;

            // The null-guard compare-and-set: `active_operation_id IS NULL` in
            // the predicate is what admits exactly one of two racing callers,
            // whatever either of them read.
            return () =>
              session.run(
                sql`UPDATE test_execution_attempt
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
    },

    async getInstruction(input: GetInstructionInput): Promise<ExecutionAttemptInstruction | null> {
      return transact(async (session) => {
        const row = await readAttemptRow(session, input.executionAttemptId);
        return row?.execution_id === input.executionId ? parseInstruction(JSON.parse(row.instruction)) : null;
      });
    },

    async reportOperation(input: ReportOperationInput): Promise<OperationReportDecision> {
      const result = parsePreparationResult(input.result);
      return transact((session) =>
        decideByWrite<OperationReportDecision>(
          async () => {
            const row = await readAttemptRow(session, input.executionAttemptId);
            if (row === undefined || row.execution_id !== input.executionId) return { kind: 'not-found' };
            const attempt = toAttemptRecord(row);
            const refusal = evaluatePreparationReport(
              {
                matchesExecution: true,
                settled: row.settlement_kind !== null,
                active: (await readActiveAttemptId(session, input.executionId)) === input.executionAttemptId,
                allocated:
                  row.allocation_ref !== null && !(await allocationTerminated(session, input.executionAttemptId)),
              },
              attempt,
              attempt,
              { ...input, result },
            );
            if (refusal !== null) return refusal;
            const preparationReceipts = parsePreparationReceipts([
              ...attempt.preparationReceipts,
              {
                operationId: input.operationId,
                runtimeGeneration: input.runtimeGeneration,
                result,
              },
            ]);
            // Persist the receipt and free the slot in one guarded write. A retry
            // reads the receipt even after another operation or runtime takes over.
            return () =>
              session.run(sql`UPDATE test_execution_attempt
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
    },

    async completeOperation(input: CompleteOperationInput): Promise<OperationCompletionDecision> {
      return transact((session) =>
        decideByWrite<OperationCompletionDecision>(
          async () => {
            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined) return { kind: 'not-found' };
            // A terminal settlement leaves the active operation in place, so a
            // late completion learns that the attempt resolved rather than that
            // its operation was never active.
            if (attemptRow.settlement_kind !== null) return { kind: 'resolved' };
            const control = decodeAttemptControlState(attemptRow);
            const refusal = evaluateOperationCompletion(control, input);
            if (refusal !== null) return refusal;

            // One statement clears all five members: a half-released operation
            // would be neither active nor absent.
            return () =>
              session.run(
                sql`UPDATE test_execution_attempt
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
    },

    async markRuntimeReady(input: MarkRuntimeReadyInput): Promise<RuntimeReadinessDecision> {
      const acceptedAt = normalizeInstant(input.readyAt);
      return transact((session) =>
        decideByWrite<RuntimeReadinessDecision>(
          async () => {
            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined || attemptRow.execution_id !== input.executionId) return { kind: 'not-found' };
            const unreachable = await runtimeReachability(session, attemptRow);
            if (unreachable !== null) return unreachable;
            const control = decodeAttemptControlState(attemptRow);
            const refusal = evaluateRuntimeReadiness(control, input);
            if (refusal !== null) return refusal;

            return () =>
              session.run(
                sql`UPDATE test_execution_attempt SET runtime_ready_at = ${acceptedAt}
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
    },

    async getAttemptControlState(executionAttemptId: string): Promise<AttemptControlState | null> {
      return transact(async (session) => {
        const row = await readAttemptRow(session, executionAttemptId);
        return row === undefined ? null : decodeAttemptControlState(row);
      });
    },

    async getActiveAttempt(executionId: string, executionAttemptId: string): Promise<ExecutionAttemptRecord | null> {
      return transact(async (session) => {
        // Settled is not superseded: a settled attempt is still the active
        // attempt for its execution until a newer one replaces it.
        const activeAttemptId = await readActiveAttemptId(session, executionId);
        if (activeAttemptId !== executionAttemptId) return null;
        const row = await readAttemptRow(session, executionAttemptId);
        return row === undefined ? null : toAttemptRecord(row);
      });
    },

    canonicalizeOutcome(outcome: TOutcome): DurableOutcome<TOutcome> {
      return durableOutcome(codec, outcome);
    },

    decodeOutcome(text: string): TOutcome {
      return decodeDurableOutcome(codec, text);
    },

    async commitOutcome(
      input: ExecutionAttemptOutcomeCommit<TOutcome>,
    ): Promise<ExecutionAttemptOutcomeDecision<TOutcome>> {
      // The text this submission writes and the value that text reads back
      // as, rendered once by `canonicalizeOutcome` and carried here. Nothing
      // is serialized again, so the column holds what the owner validated.
      const submission = input.result;
      const fence = input.runtimeFence;
      const runtimeGuard =
        fence === undefined
          ? sql`1 = 1`
          : sql`
        runtime_generation = ${fence.runtimeGeneration}
        AND ${
          fence.operationId === null
            ? sql`active_operation_id IS NULL`
            : sql`active_operation_id = ${fence.operationId}
                AND active_operation_generation = ${fence.runtimeGeneration}`
        }`;
      return transact((session) =>
        decideByWrite<ExecutionAttemptOutcomeDecision<TOutcome>>(
          async () => {
            // Deliberately claim-independent: a worker's answer is never fenced
            // by provider-operation ownership. The precedence below is the one
            // the port mandates — fence, then committed outcome, then a
            // competing terminal settlement.
            const activeAttemptId = await readActiveAttemptId(session, input.executionId);
            if (activeAttemptId !== input.executionAttemptId) return { kind: 'fenced' };

            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined) return { kind: 'fenced' };

            // A `NULL` column is the only way this realization records "no
            // outcome committed", which is why the port keeps nullish outcomes
            // outside itself: a stored JSON `null` would be indistinguishable.
            //
            // The comparison runs on the column text itself, not on a
            // re-serialization of what it decodes to: the stored text is what
            // the first commit wrote, and a codec that normalizes need not
            // serialize its own normalized value back to it.
            const storedText = attemptRow.workflow_result;
            if (storedText !== null) {
              // Decoded before the decision, not only on the duplicate
              // branch. A stored text the codec rejects — durable corruption,
              // or a codec the owner changed under an existing row — is
              // broken durable state, and answering `conflict` for it would
              // report it to the caller as an ordinary competing outcome and
              // reject the waiter with a misleading error. The port's rule is
              // that every committed outcome read from storage passes its
              // codec.
              const committed = decodeDurableOutcome(codec, storedText);
              // The column's own text travels with the decision, not the
              // retry's rendering: the two are the same outcome under
              // `sameDurableOutcome` without being the same text, and what a
              // caller decodes for a waiter must be what the row holds.
              return sameDurableOutcome(storedText, submission.text)
                ? { kind: 'duplicate', outcome: committed, text: storedText }
                : { kind: 'conflict' };
            }
            // A settlement without a committed outcome means a competing
            // terminal transition won the CAS. It keeps its settlement kind:
            // the loser of a terminal race never rewrites the winner's answer.
            if (attemptRow.settlement_kind !== null) return { kind: 'conflict' };

            if (fence !== undefined) assertRuntimeOutcomeFence(decodeAttemptControlState(attemptRow), fence);

            return async () => {
              const committed = await session.run(
                sql`UPDATE test_execution_attempt SET workflow_result = ${submission.text}
                  WHERE execution_attempt_id = ${input.executionAttemptId}
                    AND workflow_result IS NULL
                    AND settlement_kind IS NULL
                    AND ${runtimeGuard}
                    AND ${isActiveAttemptRow()}`,
              );
              if (committed.rowsAffected === 0) return committed;
              // Only the transaction that committed the outcome settles for it.
              return settleAttempt(session, input.executionAttemptId, 'outcome', sql`workflow_result IS NOT NULL`);
            };
          },
          // The accepted outcome is what a reload of the column returns:
          // `submission.text` decoded again, never `submission.outcome`. That
          // value has been in the caller's hands since before its own
          // validation, and a mutable outcome mutated there would be reported
          // as committed while the column holds the original.
          { kind: 'accepted', outcome: decodeDurableOutcome(codec, submission.text), text: submission.text },
        ),
      );
    },

    async abandonPendingAttempt(
      executionAttemptId: string,
      executionId: string,
    ): Promise<PendingAttemptAbandonmentDecision> {
      return transact((session) =>
        decideByWrite<PendingAttemptAbandonmentDecision>(
          async () => {
            const activeAttemptId = await readActiveAttemptId(session, executionId);
            if (activeAttemptId !== executionAttemptId) return { kind: 'fenced' };
            const attemptRow = await readAttemptRow(session, executionAttemptId);
            if (attemptRow === undefined) return { kind: 'fenced' };
            const attempt = toAttemptRecord(attemptRow);
            if (attempt.status === 'allocated') return { kind: 'allocated' };
            if (attempt.status === 'provisioning') return { kind: 'provisioning' };
            if (attempt.status === 'settled') {
              return { kind: attempt.settlementKind === 'abandoned' ? 'already-abandoned' : 'already-settled' };
            }
            return () =>
              session.run(
                // The start gate closes with the settlement, as it does for
                // every other terminal transition: a settled attempt never
                // starts work again.
                sql`UPDATE test_execution_attempt
                  SET status = ${'settled'}, settlement_kind = ${'abandoned'}, claimable = ${0},
                      operation_start_gate = ${'closed'}
                  WHERE execution_attempt_id = ${executionAttemptId}
                    AND execution_id = ${executionId}
                    AND status = ${'pending'}
                    AND settlement_kind IS NULL
                    AND ${isActiveAttemptRow()}`,
              );
          },
          { kind: 'abandoned' },
        ),
      );
    },

    recovery,
  };
}
