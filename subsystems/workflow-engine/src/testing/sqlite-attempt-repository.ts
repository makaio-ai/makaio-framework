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
import type { ProviderAllocationRef, WorkflowRunResult } from '@makaio/contracts';
import {
  BoundedRecoveryEvidenceSchema,
  ProviderAllocationRefSchema,
  WorkerAllocationLifetimeSchema,
  WorkflowRunResultSchema,
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
  DuplicateExecutionAttemptError,
  EXECUTION_ATTEMPT_SETTLEMENT_KINDS,
  EXECUTION_ATTEMPT_STATUSES,
  sameAllocationRef,
  sameWorkflowResult,
} from '../execution-attempt-repository.js';
import type {
  AllocationRecordingDecision,
  AllocationRefEvolution,
  AllocationRefEvolutionDecision,
  AllocationTerminationDecision,
  BeginProvisioningInput,
  DiscoveredAllocationDecision,
  ExecutionAttemptCreate,
  ExecutionAttemptOutcomeCommit,
  ExecutionAttemptOutcomeDecision,
  ExecutionAttemptRecord,
  ExecutionAttemptRecoveryOperations,
  ExecutionAttemptRepository,
  ExecutionAttemptSettlementKind,
  HandoffProviderOperationInput,
  InfrastructureFailureDecision,
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
  RenewProviderOperationClaimInput,
  TakeOverProviderOperationInput,
} from '../execution-attempt-repository.js';
import { PROVIDER_OPERATION_OBLIGATIONS } from '../provider-operation.js';
import type {
  ProviderOperationClaim,
  ProviderOperationClaimDecision,
  ProviderOperationMutationDecision,
  ProviderOperationOwnershipRecord,
} from '../provider-operation.js';
import {
  instantOf,
  normalizeInstant,
  parseAllocationLifetime,
  parseAllocationRef,
  parseAllocationRefEvolution,
  parseWorkflowResult,
  requireAllocationRefProvider,
  toRecoverableAttempt,
} from './attempt-record-codec.js';

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
     status TEXT NOT NULL,
     provider_id TEXT,
     allocation_lifetime TEXT,
     provisioner_incarnation_id TEXT,
     allocation_ref TEXT,
     settlement_kind TEXT,
     workflow_result TEXT,
     claimable INTEGER NOT NULL DEFAULT 0,
     claim_expires_at TEXT,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS test_active_execution_attempt (
     execution_id TEXT PRIMARY KEY,
     execution_attempt_id TEXT NOT NULL
       REFERENCES test_execution_attempt(execution_attempt_id)
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
     last_failure TEXT
   )`,
] as const;

// ─────────────────────────────────────────────────────────────
// Stored row shapes
// ─────────────────────────────────────────────────────────────

/** One row of `test_execution_attempt`, exactly as SQLite returns it. */
interface AttemptRow extends Record<string, unknown> {
  readonly execution_attempt_id: string;
  readonly execution_id: string;
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
 * Map an attempt row onto the port's attempt record.
 * @param row - Row read from `test_execution_attempt`.
 * @returns The JSON-safe attempt record the port defines.
 */
function toAttemptRecord(row: AttemptRow): ExecutionAttemptRecord {
  return {
    executionAttemptId: row.execution_attempt_id,
    executionId: row.execution_id,
    status: parseMember(EXECUTION_ATTEMPT_STATUSES, row.status, 'status'),
    allocationRef: parseJsonColumn<ProviderAllocationRef>(row.allocation_ref, (value) =>
      ProviderAllocationRefSchema.parse(value),
    ),
    createdAt: row.created_at,
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
 * @param accepted - Decision reported when the guarded write applied.
 * @returns The refusal, or `accepted` when the write applied.
 * @throws When the write applies nothing while durable state still permits it.
 * @typeParam TDecision - Decision vocabulary of the transition.
 */
async function decideByWrite<TDecision extends { readonly kind: string }>(
  read: () => Promise<TDecision | GuardedWrite>,
  accepted: TDecision,
): Promise<TDecision> {
  const first = await read();
  if (typeof first !== 'function') return first;
  if ((await first()).rowsAffected > 0) return accepted;

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
 * Predicate asserting that an attempt has not settled.
 * @param executionAttemptId - Attempt to constrain.
 * @returns A predicate over the attempt's own row.
 */
function attemptUnsettled(executionAttemptId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM test_execution_attempt
                     WHERE execution_attempt_id = ${executionAttemptId} AND settlement_kind IS NULL)`;
}

/**
 * Predicate repeating, as part of a write, what authorization read.
 *
 * Both halves matter: the claim must still be the current one, and the
 * attempt must not have settled underneath it.
 * @param claim - Claim the write is authorized by.
 * @returns A predicate that holds exactly while the claim authorizes a write.
 */
function claimAuthorizes(claim: ProviderOperationClaim): SQL {
  return sql`${claimHolds(claim)} AND ${attemptUnsettled(claim.executionAttemptId)}`;
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
 * @returns A repository exposing the full port surface, backed by SQLite.
 */
export async function createSqliteAttemptRepository(db: MakaioDatabase): Promise<Required<ExecutionAttemptRepository>> {
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
    if (attempt.settlementKind != null) return { kind: 'resolved', attempt };
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
   * Settle an attempt and close its operation in one guarded write.
   *
   * The terminal transition is the settlement itself: it applies only while
   * the attempt is unsettled and `guard` still holds, which is what makes the
   * first terminal writer the winner and every later one a loser that changes
   * nothing. A settled attempt must never leave an owned operation behind, so
   * the operation is closed in the same transaction, and only once the
   * settlement actually applied.
   * @param session - Session inside the current transaction.
   * @param executionAttemptId - Attempt reaching a terminal state.
   * @param settlementKind - How the attempt reached that state.
   * @param guard - Transition-specific predicate the attempt row must satisfy.
   * @param lastFailure - Bounded evidence to retain, or `undefined` to keep what is stored.
   * @returns The settlement write's affected-row count.
   */
  const settleAndCloseOperation = async (
    session: RawSqlSession,
    executionAttemptId: string,
    settlementKind: NonNullable<ExecutionAttemptSettlementKind>,
    guard: SQL,
    lastFailure?: BoundedRecoveryEvidence,
  ): Promise<{ rowsAffected: number }> => {
    const settled = await session.run(
      sql`UPDATE test_execution_attempt
          SET status = ${'settled'}, settlement_kind = ${settlementKind}, claimable = ${0}
          WHERE execution_attempt_id = ${executionAttemptId}
            AND settlement_kind IS NULL
            AND ${guard}`,
    );
    if (settled.rowsAffected === 0) return settled;
    await session.run(
      lastFailure === undefined
        ? sql`UPDATE test_provider_operation
              SET owner_id = NULL, token = NULL, lease_expires_at = NULL
              WHERE execution_attempt_id = ${executionAttemptId}`
        : sql`UPDATE test_provider_operation
              SET owner_id = NULL, token = NULL, lease_expires_at = NULL, last_failure = ${JSON.stringify(lastFailure)}
              WHERE execution_attempt_id = ${executionAttemptId}`,
    );
    return settled;
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
    const claimable = bootstrapClaimable ? sql`CASE WHEN ${isActiveAttemptRow()} THEN 1 ELSE 0 END` : sql`${0}`;
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
                SET status = ${'allocated'},
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
  };

  return {
    async createAttempt(input: ExecutionAttemptCreate): Promise<ExecutionAttemptRecord> {
      return transact(async (session) => {
        const createdAt = new Date().toISOString();
        // The primary key is what rejects a reused attempt identifier. The
        // port makes that a caller bug precisely so no implementation has to
        // choose between overwriting a possibly settled attempt and silently
        // ignoring the call. Letting the store decide is the race-free way to
        // detect it, so the constraint violation is translated into the port's
        // own error rather than a caller having to recognize driver text.
        try {
          await session.run(
            sql`INSERT INTO test_execution_attempt
                (execution_attempt_id, execution_id, status, claimable, created_at)
              VALUES (${input.executionAttemptId}, ${input.executionId}, ${'pending'}, ${0}, ${createdAt})`,
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
        await session.run(
          sql`INSERT INTO test_active_execution_attempt (execution_id, execution_attempt_id)
              VALUES (${input.executionId}, ${input.executionAttemptId})
              ON CONFLICT(execution_id)
              DO UPDATE SET execution_attempt_id = excluded.execution_attempt_id`,
        );
        return {
          executionAttemptId: input.executionAttemptId,
          executionId: input.executionId,
          status: 'pending',
          allocationRef: null,
          createdAt,
          providerId: null,
          allocationLifetime: null,
          provisionerIncarnationId: null,
          settlementKind: null,
          claimable: false,
          claimExpiresAt: null,
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
        if (attemptRow.settlement_kind !== null) return { kind: 'resolved' };
        const held =
          operation.owner_id !== null &&
          operation.lease_expires_at !== null &&
          instantOf(operation.lease_expires_at) > instantOf(input.observedAt);
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
        // settlement guard closes the same race against a terminal
        // transition; a taker that loses either one is told to re-read.
        const { rowsAffected } = await session.run(
          sql`UPDATE test_provider_operation
              SET generation = ${claim.generation}, owner_id = ${claim.ownerId}, token = ${claim.token},
                  lease_expires_at = ${claim.leaseExpiresAt}
              WHERE execution_attempt_id = ${input.executionAttemptId}
                AND generation = ${operation.generation}
                AND ${attemptUnsettled(input.executionAttemptId)}`,
        );
        if (rowsAffected === 0) return { kind: 'stale' };
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

    async recordAllocation(input: RecordAllocationInput): Promise<AllocationRecordingDecision> {
      return applyAllocation(input, true);
    },

    async recordProvisioningAbsent(input: RecordProvisioningAbsentInput): Promise<ProvisioningAbsenceDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.evidence);
      return transact((session) =>
        decideByWrite<ProvisioningAbsenceDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            if (attempt.allocationRef !== null) return { kind: 'allocated', allocationRef: attempt.allocationRef };

            return () =>
              settleAndCloseOperation(
                session,
                attempt.executionAttemptId,
                'abandoned',
                sql`execution_id = ${input.executionId}
                  AND allocation_ref IS NULL
                  AND ${claimHolds(input.claim)}`,
                evidence,
              );
          },
          { kind: 'recorded' },
        ),
      );
    },

    async recordProvisionerIncarnationLost(
      input: RecordProvisionerIncarnationLostInput,
    ): Promise<ProvisionerIncarnationLossDecision> {
      const evidence = BoundedRecoveryEvidenceSchema.parse(input.proof.evidence);
      return transact((session) =>
        decideByWrite<ProvisionerIncarnationLossDecision>(
          async () => {
            const authorization = await authorize(session, input.claim);
            if (authorization.kind !== 'authorized') return { kind: authorization.kind };
            const { attempt } = authorization;
            if (attempt.executionId !== input.executionId) return { kind: 'not-found' };
            // Applicability first, ownership second: whether the proof says
            // anything about this attempt at all is decided by the two
            // immutable facts `beginProvisioning` bound, and only an applicable
            // proof then has to answer for a recorded allocation.
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

            // Both immutable facts are repeated in the predicate, so the write
            // applies only against the very attempt the proof was judged
            // against — never against one a concurrent transition reshaped.
            return () =>
              settleAndCloseOperation(
                session,
                attempt.executionAttemptId,
                'abandoned',
                sql`execution_id = ${input.executionId}
                  AND allocation_ref IS NULL
                  AND allocation_lifetime = ${'provisioner-process-bound'}
                  AND provisioner_incarnation_id = ${input.proof.provisionerIncarnationId}
                  AND ${claimHolds(input.claim)}`,
                evidence,
              );
          },
          { kind: 'recorded' },
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
            if (attempt.allocationRef === null) return { kind: 'not-allocated' };
            // Terminal settlement is irreversible, so it may only follow the
            // durable evidence that the allocation actually ended. An
            // operation still owing allocation control has not recorded that
            // evidence yet. The stored value is narrowed rather than compared
            // raw, so corruption fails loudly instead of reading as a refusal.
            const obligation = parseMember(PROVIDER_OPERATION_OBLIGATIONS, operation.obligation, 'obligation');
            if (obligation !== 'terminal-convergence') return { kind: 'not-terminated' };

            return () =>
              settleAndCloseOperation(
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

    async commitOutcome(input: ExecutionAttemptOutcomeCommit): Promise<ExecutionAttemptOutcomeDecision> {
      const result = parseWorkflowResult(input.result);
      return transact((session) =>
        decideByWrite<ExecutionAttemptOutcomeDecision>(
          async () => {
            // Deliberately claim-independent: a worker's answer is never fenced
            // by provider-operation ownership. The precedence below is the one
            // the port mandates — fence, then committed outcome, then a
            // competing terminal settlement.
            const activeAttemptId = await readActiveAttemptId(session, input.executionId);
            if (activeAttemptId !== input.executionAttemptId) return { kind: 'fenced' };

            const attemptRow = await readAttemptRow(session, input.executionAttemptId);
            if (attemptRow === undefined) return { kind: 'fenced' };

            const prior = parseJsonColumn<WorkflowRunResult>(attemptRow.workflow_result, (value) =>
              WorkflowRunResultSchema.parse(value),
            );
            if (prior !== null) {
              return sameWorkflowResult(prior, result) ? { kind: 'duplicate', outcome: prior } : { kind: 'conflict' };
            }
            // A settlement without a committed outcome means a competing
            // terminal transition won the CAS. It keeps its settlement kind:
            // the loser of a terminal race never rewrites the winner's answer.
            if (attemptRow.settlement_kind !== null) return { kind: 'conflict' };

            return async () => {
              const committed = await session.run(
                sql`UPDATE test_execution_attempt SET workflow_result = ${JSON.stringify(result)}
                  WHERE execution_attempt_id = ${input.executionAttemptId}
                    AND workflow_result IS NULL
                    AND settlement_kind IS NULL
                    AND ${isActiveAttemptRow()}`,
              );
              if (committed.rowsAffected === 0) return committed;
              // Only the transaction that committed the outcome settles for it.
              return settleAndCloseOperation(
                session,
                input.executionAttemptId,
                'outcome',
                sql`workflow_result IS NOT NULL`,
              );
            };
          },
          { kind: 'accepted', outcome: result },
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
                sql`UPDATE test_execution_attempt
                  SET status = ${'settled'}, settlement_kind = ${'abandoned'}, claimable = ${0}
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
