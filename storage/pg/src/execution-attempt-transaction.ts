/**
 * PostgreSQL transaction and compare-and-set primitives for execution attempts.
 *
 * This module owns the adapter's connection-scoped atomicity, owner fencing,
 * and correlated write predicates. Repository operations compose these helpers
 * with their port-specific reads and evaluators.
 */
import { sql, type SQL } from 'drizzle-orm';
import { getRawSqlExecutor, type MakaioDatabase, type RawSqlSession } from '@makaio/storage-drizzle';
import type { ProviderOperationClaim } from '@makaio/subsystem-workflow-engine';
import { postgresTransactionLockExpressions } from './transaction-locks.js';

/** A write that reports whether its complete durable guard still held. */
export type GuardedWrite = () => Promise<{ readonly rowsAffected: number }>;

/**
 * The connection-scoped operations used by execution-attempt transitions.
 *
 * `transact` is intentionally the only entry point that issues PostgreSQL
 * transaction control statements. `lockOwner` is parameterized through the
 * shared advisory-lock expression factory and must run inside `transact`.
 */
export interface ExecutionAttemptTransaction {
  readonly transact: <TResult>(work: (session: RawSqlSession) => Promise<TResult>) => Promise<TResult>;
  readonly lockOwner: (session: RawSqlSession, executionId: string) => Promise<void>;
}

/**
 * Validate the database handle and create the execution-attempt transaction
 * boundary.
 *
 * All control statements execute only while `withSession` has checked out one
 * PostgreSQL connection. When rollback itself fails, both the original and
 * rollback errors remain observable so the driver can discard the poisoned
 * connection.
 * @param db - Branded database handle to bind to one PostgreSQL session per transition.
 * @returns Connection-pinned transaction and owner-lock operations.
 */
export function createExecutionAttemptTransaction(db: MakaioDatabase): ExecutionAttemptTransaction {
  const executor = getRawSqlExecutor(db);
  if (executor.dialect !== 'postgres') {
    throw new Error('createPostgresExecutionAttemptRepository requires a branded PostgreSQL database');
  }

  const transact = async <TResult>(work: (session: RawSqlSession) => Promise<TResult>): Promise<TResult> =>
    executor.withSession(async (session) => {
      let began = false;
      try {
        await session.run(sql.raw('BEGIN ISOLATION LEVEL READ COMMITTED'));
        began = true;
        const result = await work(session);
        await session.run(sql.raw('COMMIT'));
        return result;
      } catch (error) {
        if (!began) throw error;
        try {
          await session.run(sql.raw('ROLLBACK'));
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'PostgreSQL transaction rollback failed');
        }
        throw error;
      }
    });

  const lockOwner = async (session: RawSqlSession, executionId: string): Promise<void> => {
    for (const expression of postgresTransactionLockExpressions([
      { namespace: 'workflow-execution-attempt', identity: executionId },
    ])) {
      await session.run(sql`SELECT ${expression}`);
    }
  };

  return { transact, lockOwner };
}

/**
 * Decide a transition from the row count of a write that repeats its guards.
 *
 * A zero-row write is re-evaluated. If durable state still permits the write,
 * the stored row changed without producing a refusal and the caller has found
 * a violated compare-and-set invariant.
 * @param read - Re-evaluates durable state and returns either a refusal or guarded write.
 * @param accepted - Decision to return after the guarded write succeeds.
 * @returns The durable refusal or accepted transition decision.
 */
export async function decideByWrite<TDecision extends { readonly kind: string }>(
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
 * Predicate asserting that a provider-operation claim still matches durable ownership.
 * @param claim - Provider-operation ownership claim to match.
 * @returns SQL predicate that verifies the exact stored claim.
 */
export function claimHolds(claim: ProviderOperationClaim): SQL {
  return sql`EXISTS (SELECT 1 FROM provider_operation
                     WHERE execution_attempt_id = ${claim.executionAttemptId}
                       AND generation = ${claim.generation}
                       AND owner_id = ${claim.ownerId}
                       AND token = ${claim.token})`;
}

/**
 * Predicate asserting that provider completion and attempt settlement have both converged.
 * @param executionAttemptId - Attempt whose provider operation is inspected.
 * @returns SQL predicate that permits unfinished provider convergence.
 */
export function operationIsUnresolved(executionAttemptId: string): SQL {
  return sql`(completion_evidence IS NULL
              OR NOT EXISTS (SELECT 1 FROM execution_attempt
                             WHERE execution_attempt_id = ${executionAttemptId}
                               AND settlement_kind IS NOT NULL))`;
}

/**
 * Predicate asserting that an unresolved operation still authorizes its current claim holder.
 * @param claim - Provider-operation ownership claim to authorize.
 * @returns SQL predicate for an unresolved operation owned by the claim.
 */
export function claimAuthorizes(claim: ProviderOperationClaim): SQL {
  return sql`EXISTS (SELECT 1 FROM provider_operation
                     WHERE execution_attempt_id = ${claim.executionAttemptId}
                       AND generation = ${claim.generation}
                       AND owner_id = ${claim.ownerId}
                       AND token = ${claim.token}
                       AND ${operationIsUnresolved(claim.executionAttemptId)})`;
}

/**
 * Predicate asserting that a provider operation still owes terminal convergence.
 * @param executionAttemptId - Attempt whose operation obligation is inspected.
 * @returns SQL predicate for a terminal-convergence obligation.
 */
export function operationOwesTerminalConvergence(executionAttemptId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM provider_operation
                     WHERE execution_attempt_id = ${executionAttemptId}
                       AND obligation = ${'terminal-convergence'})`;
}

/**
 * Predicate asserting that the `execution_attempt` row being written remains active.
 * @returns SQL predicate correlated to the row being updated.
 */
export function isActiveAttemptRow(): SQL {
  return sql`EXISTS (SELECT 1 FROM active_execution_attempt
                     WHERE execution_id = execution_attempt.execution_id
                       AND execution_attempt_id = execution_attempt.execution_attempt_id)`;
}
