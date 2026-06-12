/**
 * Filesystem-free migration applicator.
 *
 * Replicates Drizzle's libsql {@link migrate} logic but accepts
 * pre-resolved {@link MigrationMeta} entries instead of reading from
 * disk. This enables bundled environments (Electron asar) to embed
 * migration SQL at build time without temp-dir hacks.
 *
 * Executes through the dialect-portable raw SQL executor resolved via
 * {@link getRawSqlExecutor}, so the migrator works with any driver backed by
 * {@link MakaioDatabase}: the pinned session runs DDL, DML, and transaction
 * control, and reads the migration ledger table.
 * @see {@link readMigrations} for the filesystem-based data source.
 */
import { createHash } from 'node:crypto';
import { sql, type Name } from 'drizzle-orm';
import {
  getRawSqlExecutor,
  isDuplicateObjectError,
  type MakaioDatabase,
  type RawSqlSession,
  type StorageDialect,
} from '@makaio/storage-drizzle';
import type { MigrationMeta } from './read-migrations.js';

/**
 * Default migration ledger table name for a dialect.
 *
 * SQLite keeps Drizzle's historical `__drizzle_migrations` name so existing
 * ledgers keep matching. Postgres uses `__makaio_migrations`, which can never
 * collide with a consumer-owned Drizzle ledger sharing the same database.
 * @param dialect - Storage dialect of the target database.
 * @returns Default ledger table name for the dialect.
 */
export function resolveDefaultMigrationsTable(dialect: StorageDialect): string {
  return dialect === 'postgres' ? '__makaio_migrations' : '__drizzle_migrations';
}

/**
 * Build the idempotent `CREATE TABLE IF NOT EXISTS` DDL for the migration
 * ledger table.
 *
 * SQLite keeps the historical Drizzle shape so existing ledgers keep
 * matching. Postgres uses an identity primary key and additionally enforces
 * hash uniqueness at the schema level: the runner already treats the hash as
 * a migration's identity, and the constraint backstops the advisory-lock
 * serialization — should a cross-process double-record ever slip past it,
 * the insert fails loudly instead of silently corrupting the ledger.
 *
 * Exported so tests can pin the exact statement text per dialect until live
 * conformance coverage executes the Postgres branch.
 * @param dialect - Storage dialect of the target database.
 * @param tableName - Ledger table name (dialect default or caller-provided).
 * @returns Complete DDL statement text.
 */
export function buildLedgerTableDdl(dialect: StorageDialect, tableName: string): string {
  const tableId = `"${tableName.replaceAll('"', '""')}"`;
  if (dialect === 'postgres') {
    return `CREATE TABLE IF NOT EXISTS ${tableId} (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      hash text NOT NULL UNIQUE,
      created_at numeric
    )`;
  }
  return `CREATE TABLE IF NOT EXISTS ${tableId} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at numeric
    )`;
}

/**
 * Build the `BEGIN` statement that opens a migration transaction.
 *
 * Postgres pins `READ COMMITTED` explicitly instead of inheriting
 * `default_transaction_isolation` (a database/role-settable setting the
 * framework does not control). The in-lock ledger recheck
 * ({@link skipIfRecordedByConcurrentRunner}) requires a snapshot taken after
 * the advisory lock is acquired; under an ambient `REPEATABLE READ` or
 * `SERIALIZABLE` default the transaction snapshot would be established by the
 * lock SELECT itself — before the lock wait completes — so the recheck would
 * miss a concurrent runner's committed ledger row and re-apply the migration.
 * `READ COMMITTED` takes a fresh snapshot per statement, and commit
 * visibility precedes lock release, so the recheck observes every ledger row
 * committed before the lock was handed over. SQLite keeps the bare historical
 * `BEGIN`.
 *
 * Exported so tests can pin the exact statement text per dialect until live
 * conformance coverage executes the Postgres branch.
 * @param dialect - Storage dialect of the target database.
 * @returns Complete `BEGIN` statement text.
 */
export function buildBeginTransactionStatement(dialect: StorageDialect): string {
  return dialect === 'postgres' ? 'BEGIN ISOLATION LEVEL READ COMMITTED' : 'BEGIN';
}

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
 * Strip SQL line comments and whitespace to detect comment-only segments.
 * @param stmt - Raw SQL statement text (may include `--` comments).
 * @returns The statement with all line comments and surrounding whitespace removed.
 */
function stripComments(stmt: string): string {
  return stmt.replace(/--.*$/gm, '').trim();
}

/**
 * Per-run state shared by the migration transaction helpers.
 */
interface MigrationRunContext {
  /** Pinned raw SQL session the whole run executes on. */
  readonly session: RawSqlSession;
  /** Active storage dialect of the target database. */
  readonly dialect: StorageDialect;
  /** Resolved ledger table name (dialect default or caller-provided). */
  readonly tableName: string;
  /** Escaped identifier of the ledger table for statement interpolation. */
  readonly tableId: Name;
  /** Advisory lock key derived from the ledger table name (used on Postgres). */
  readonly lockKey: bigint;
}

/**
 * Roll back the open transaction, logging (but swallowing) rollback failures
 * so the error that triggered the rollback stays the one that propagates.
 * @param session - Pinned session whose transaction should be rolled back.
 * @param logContext - Structured payload for the rollback-failure diagnostic.
 */
async function rollbackSwallowingErrors(session: RawSqlSession, logContext: Record<string, unknown>): Promise<void> {
  try {
    await session.run(sql.raw('ROLLBACK'));
  } catch (rollbackError) {
    console.error('[storage-migrations] Failed to roll back migration transaction', {
      ...logContext,
      rollbackError,
    });
  }
}

/**
 * Open a transaction on the pinned session.
 *
 * On Postgres, every transaction the run opens immediately takes the
 * transaction-scoped advisory lock derived from the ledger table name. A
 * transaction-scoped lock cannot outlive its transaction, so re-acquiring it
 * per transaction is what serializes every ledger read and write of
 * concurrent multi-process runners; because the lock releases automatically
 * at COMMIT/ROLLBACK, every apply decision additionally re-reads the ledger
 * under its own lock ({@link skipIfRecordedByConcurrentRunner}) instead of
 * trusting the run-level snapshot. SQLite takes no lock: its single-writer
 * semantics already serialize within the supported envelope.
 *
 * Postgres transactions pin `READ COMMITTED` because the in-lock recheck
 * requires a post-lock-acquisition snapshot — see
 * {@link buildBeginTransactionStatement} for the full rationale.
 *
 * Cleanup contract: resolves with a usable locked transaction open, or rolls
 * the fresh transaction back before rethrowing when the lock acquisition
 * fails after BEGIN (lock timeout, administrative cancel during a contended
 * wait) — the session never leaves this helper inside an aborted transaction.
 * @param context - Run context carrying the session, dialect, and lock key.
 */
async function beginMigrationTransaction(context: MigrationRunContext): Promise<void> {
  await context.session.run(sql.raw(buildBeginTransactionStatement(context.dialect)));
  if (context.dialect === 'postgres') {
    // Bound as text and cast server-side: signed 64-bit keys exceed JS number
    // precision and driver BigInt parameter support varies.
    const lockKey = context.lockKey.toString();
    try {
      await context.session.run(sql`SELECT pg_advisory_xact_lock(CAST(${lockKey} AS bigint))`);
    } catch (error) {
      await rollbackSwallowingErrors(context.session, { migrationsTable: context.tableName });
      throw error;
    }
  }
}

/**
 * Create the ledger table if absent and snapshot the applied migration hashes.
 *
 * On Postgres both statements run inside their own advisory-locked
 * transaction so the snapshot cannot interleave with another runner's
 * in-flight ledger writes. The lock releases when the snapshot transaction
 * commits, so on Postgres the snapshot is only a fast path: each apply
 * decision re-validates against the ledger under its own lock
 * ({@link skipIfRecordedByConcurrentRunner}). On SQLite both statements stay
 * in autocommit, preserving the historical statement flow.
 * @param context - Run context for the pinned session.
 * @returns Hashes already recorded in the ledger.
 */
async function snapshotAppliedHashes(context: MigrationRunContext): Promise<Set<string>> {
  const lockedTransaction = context.dialect === 'postgres';
  if (lockedTransaction) {
    await beginMigrationTransaction(context);
  }
  try {
    await context.session.run(sql.raw(buildLedgerTableDdl(context.dialect, context.tableName)));
    const appliedRows = await context.session.all<{ hash: string }>(sql`SELECT hash FROM ${context.tableId}`);
    if (lockedTransaction) {
      await context.session.run(sql.raw('COMMIT'));
    }
    return new Set(appliedRows.map((row) => row.hash));
  } catch (error) {
    if (lockedTransaction) {
      await rollbackSwallowingErrors(context.session, { migrationsTable: context.tableName });
    }
    throw error;
  }
}

/**
 * Record the migration in the ledger and commit the open transaction.
 *
 * Called from the success path with the migration's own transaction still
 * open, so the schema/data changes and the ledger row commit atomically.
 * The adoption path calls it inside a fresh transaction holding only the
 * ledger insert.
 * @param context - Run context for the pinned session.
 * @param migration - Migration whose hash should be recorded.
 */
async function recordMigrationAndCommit(context: MigrationRunContext, migration: MigrationMeta): Promise<void> {
  try {
    await context.session.run(
      sql`INSERT INTO ${context.tableId} ("hash", "created_at") VALUES (${migration.hash}, ${migration.folderMillis})`,
    );
    await context.session.run(sql.raw('COMMIT'));
  } catch (error) {
    console.error('[storage-migrations] Failed to finalize migration', {
      hash: migration.hash,
      folderMillis: migration.folderMillis,
      error,
    });
    throw error;
  }
}

/**
 * Skip the migration when a concurrent runner already recorded it, deciding
 * under the advisory lock of the open transaction.
 *
 * Postgres only: the run-level snapshot releases its advisory lock when the
 * snapshot transaction commits, so it is stale relative to runners that
 * commit between the snapshot and this migration's transaction. Re-reading
 * the ledger row while holding the lock fully serializes the apply/skip
 * decision (sound because migration transactions pin `READ COMMITTED`, see
 * {@link buildBeginTransactionStatement}) — a runner that loses the race
 * commits its empty transaction and
 * skips cleanly instead of failing on a duplicate object or the ledger's
 * UNIQUE hash constraint. SQLite never re-reads: its single-writer semantics
 * make the snapshot authoritative within the supported envelope, and the
 * statement stream stays byte-identical to the historical flow.
 * @param context - Run context for the pinned session.
 * @param migration - Migration the open transaction would apply or adopt.
 * @returns `true` when the migration was already recorded and the open
 *   transaction has been committed (the caller must skip); `false` when the
 *   caller should proceed inside the still-open transaction.
 */
async function skipIfRecordedByConcurrentRunner(
  context: MigrationRunContext,
  migration: MigrationMeta,
): Promise<boolean> {
  if (context.dialect !== 'postgres') {
    return false;
  }
  const recorded = await context.session.all<{ hash: string }>(
    sql`SELECT hash FROM ${context.tableId} WHERE hash = ${migration.hash}`,
  );
  if (recorded.length === 0) {
    return false;
  }
  console.warn('[storage-migrations] Migration already recorded by a concurrent runner, skipping', {
    hash: migration.hash,
    folderMillis: migration.folderMillis,
  });
  await context.session.run(sql.raw('COMMIT'));
  return true;
}

/**
 * Record an adopted migration hash in a fresh transaction.
 *
 * A failed CREATE poisons an open Postgres transaction (SQLSTATE 25P02): no
 * further statement, including the ledger insert, may execute inside it. The
 * adoption record therefore rolls back the poisoned transaction and records
 * the hash in a fresh BEGIN/COMMIT on the same pinned session. On SQLite the
 * rolled-back transaction held only the failed CREATE, so this flow is
 * behaviorally identical to recording in place. On Postgres the ROLLBACK
 * also released the advisory lock, so the fresh transaction re-checks the
 * ledger before inserting — a concurrent runner may have recorded the same
 * migration in the gap.
 * @param context - Run context for the pinned session.
 * @param migration - Adopted migration whose hash should be recorded.
 */
async function adoptMigrationIntoLedger(context: MigrationRunContext, migration: MigrationMeta): Promise<void> {
  await context.session.run(sql.raw('ROLLBACK'));
  await beginMigrationTransaction(context);
  if (await skipIfRecordedByConcurrentRunner(context, migration)) {
    return;
  }
  await recordMigrationAndCommit(context, migration);
}

/**
 * Apply a single unapplied migration atomically on the pinned session.
 *
 * Runs the migration's statements and its ledger insert inside one
 * transaction, rolling back on any failure. On Postgres the transaction
 * first re-validates the ledger under its advisory lock
 * ({@link skipIfRecordedByConcurrentRunner}) so a migration recorded by a
 * concurrent runner is skipped cleanly. A single-statement `CREATE`
 * migration whose schema object already exists is adopted into the ledger
 * without re-running the `CREATE` (see {@link adoptMigrationIntoLedger});
 * multi-statement migrations refuse adoption because partial pre-existence
 * cannot be verified.
 * @param context - Run context for the pinned session.
 * @param migration - Migration entry to apply.
 */
async function applyMigrationInTransaction(context: MigrationRunContext, migration: MigrationMeta): Promise<void> {
  await beginMigrationTransaction(context);
  try {
    if (await skipIfRecordedByConcurrentRunner(context, migration)) {
      return;
    }
    for (const [statementIndex, stmt] of migration.sql.entries()) {
      if (!stripComments(stmt)) continue;
      try {
        await context.session.run(sql.raw(stmt));
      } catch (error) {
        if (statementIndex === 0 && /^\s*CREATE\s/i.test(stmt) && isDuplicateObjectError(error, context.dialect)) {
          if (migration.sql.length > 1) {
            throw new Error(
              `Cannot adopt multi-statement migration '${migration.tag}' because its first schema object already exists. Reset the database or provide an incremental migration.`,
              { cause: error },
            );
          }
          console.warn('[storage-migrations] Schema object already exists, adopting into ledger', {
            hash: migration.hash,
            folderMillis: migration.folderMillis,
            statementIndex,
          });
          // Adoption means this single-statement migration's schema change is
          // already present outside the ledger, so record this same migration
          // hash without re-running the CREATE.
          await adoptMigrationIntoLedger(context, migration);
          return;
        }
        console.error('[storage-migrations] Failed to apply migration statement', {
          hash: migration.hash,
          folderMillis: migration.folderMillis,
          statementIndex,
          statement: stmt,
          error,
        });
        throw error;
      }
    }

    await recordMigrationAndCommit(context, migration);
  } catch (error) {
    await rollbackSwallowingErrors(context.session, {
      hash: migration.hash,
      folderMillis: migration.folderMillis,
    });
    throw error;
  }
}

/**
 * Apply pre-resolved migrations to a database.
 *
 * Creates the dialect's migration ledger table if absent
 * ({@link resolveDefaultMigrationsTable}), reads all previously applied
 * migration hashes into a Set, then executes each unapplied migration inside
 * its own transaction so the schema/data change and ledger row commit
 * atomically.
 *
 * Deduplication is by hash (not by timestamp), making it safe for multiple
 * central-tier runners that share the same ledger table. A migration from a
 * second runner with an earlier timestamp than the latest migration from the
 * first runner will still be applied correctly because the decision is
 * `!appliedHashes.has(migration.hash)`.
 *
 * The entire run executes on one pinned session so raw transaction control
 * (BEGIN/COMMIT/ROLLBACK) never leaves the connection that issued it — on a
 * pooled backend, standalone statements would stripe across connections. On
 * Postgres, every transaction the run opens pins `READ COMMITTED`
 * ({@link buildBeginTransactionStatement}), additionally takes a
 * transaction-scoped advisory lock ({@link migrationAdvisoryLockKey}), and
 * re-validates the ledger under that lock before applying or adopting, so
 * concurrent multi-process runners serialize their apply decisions: a runner
 * that loses the race skips the migration cleanly instead of racing the
 * snapshot into a duplicate-object or constraint failure.
 *
 * Idempotent — safe to call on every startup.
 * @param db - Makaio database instance.
 * @param migrations - Ordered migration entries from {@link readMigrations}
 *   or from build-time embedding.
 * @param migrationsTable - Ledger table name. Defaults per dialect:
 *   `__drizzle_migrations` on SQLite, `__makaio_migrations` on Postgres.
 */
export async function applyMigrations(
  db: MakaioDatabase,
  migrations: MigrationMeta[],
  migrationsTable?: string,
): Promise<void> {
  const executor = getRawSqlExecutor(db);
  const tableName = migrationsTable ?? resolveDefaultMigrationsTable(executor.dialect);

  await executor.withSession(async (session) => {
    const context: MigrationRunContext = {
      session,
      dialect: executor.dialect,
      tableName,
      tableId: sql.identifier(tableName),
      lockKey: migrationAdvisoryLockKey(tableName),
    };

    const appliedHashes = await snapshotAppliedHashes(context);

    for (const migration of migrations) {
      if (appliedHashes.has(migration.hash)) continue;
      await applyMigrationInTransaction(context, migration);
      appliedHashes.add(migration.hash);
    }
  });
}
