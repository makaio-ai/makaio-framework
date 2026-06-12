/**
 * Postgres migration behavior: ledger DDL, transaction pinning, and the
 * cross-process advisory lock protocol.
 *
 * The statement texts and key derivations in this module are cross-version
 * contracts — runners built from different framework versions must agree on
 * them byte-for-byte, otherwise concurrent runs stop serializing against each
 * other or stop recognizing each other's ledgers. Every value is pinned by
 * unit tests and exercised by the live conformance coverage in
 * `storage/conformance/src/suites/migration-runner-postgres.test.ts`.
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { quoteSqlIdentifier, type RawSqlSession } from '@makaio/storage-drizzle';

/**
 * Derive the 64-bit advisory lock key for a migration ledger table.
 *
 * The key is the first 8 bytes (big-endian, signed) of
 * `SHA-256("makaio:migrations:<tableName>")`. The derivation is a
 * cross-version contract: concurrent runners built from different framework
 * versions must compute the same key for the same ledger table, otherwise
 * they stop serializing against each other.
 * @param tableName - Ledger table name the run serializes on.
 * @returns Signed 64-bit key for `pg_advisory_xact_lock`.
 */
export function migrationAdvisoryLockKey(tableName: string): bigint {
  return createHash('sha256').update(`makaio:migrations:${tableName}`).digest().readBigInt64BE(0);
}

/**
 * Build the idempotent `CREATE TABLE IF NOT EXISTS` DDL for the Postgres
 * migration ledger table.
 *
 * Uses an identity primary key and additionally enforces hash uniqueness at
 * the schema level: the runner already treats the hash as a migration's
 * identity, and the constraint backstops the advisory-lock serialization —
 * should a cross-process double-record ever slip past it, the insert fails
 * loudly instead of silently corrupting the ledger. The exact statement text
 * is a cross-version contract pinned by tests.
 * @param tableName - Ledger table name (engine default or caller-provided).
 * @returns Complete DDL statement text.
 */
export function buildPostgresLedgerDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${quoteSqlIdentifier(tableName)} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      hash text NOT NULL UNIQUE,
      created_at numeric
    )`;
}

/**
 * `BEGIN` statement that opens a Postgres migration transaction.
 *
 * Pins `READ COMMITTED` explicitly instead of inheriting
 * `default_transaction_isolation` (a database/role-settable setting the
 * framework does not control). The migration applicator's in-lock ledger
 * recheck requires a snapshot taken after the advisory lock is acquired;
 * under an ambient `REPEATABLE READ` or `SERIALIZABLE` default the
 * transaction snapshot would be established by the lock SELECT itself —
 * before the lock wait completes — so the recheck would miss a concurrent
 * runner's committed ledger row and re-apply the migration. `READ COMMITTED`
 * takes a fresh snapshot per statement, and commit visibility precedes lock
 * release, so the recheck observes every ledger row committed before the
 * lock was handed over.
 */
export const POSTGRES_MIGRATION_BEGIN = 'BEGIN ISOLATION LEVEL READ COMMITTED';

/**
 * Acquire the transaction-scoped advisory lock that serializes concurrent
 * migration runners on the same ledger table.
 *
 * Must be called inside an open transaction on the pinned session; the lock
 * releases automatically at COMMIT/ROLLBACK. The key is bound as text and
 * cast server-side: signed 64-bit keys exceed JS number precision and driver
 * BigInt parameter support varies. The caller owns rollback-on-failure — a
 * rejected lock acquisition (lock timeout, administrative cancel during a
 * contended wait) leaves the transaction open for the caller to roll back.
 * @param session - Pinned raw SQL session with the transaction open.
 * @param ledgerTableName - Ledger table name the lock key is derived from.
 * @returns Resolves once the lock is held for the transaction's lifetime.
 */
export async function acquirePostgresMigrationLock(session: RawSqlSession, ledgerTableName: string): Promise<void> {
  const lockKey = migrationAdvisoryLockKey(ledgerTableName).toString();
  await session.run(sql`SELECT pg_advisory_xact_lock(CAST(${lockKey} AS bigint))`);
}
