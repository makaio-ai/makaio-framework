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
 *
 * Per-engine mechanics — ledger naming and DDL, the `BEGIN` flavor, the
 * cross-process locking protocol, and the constraint-suspension protocol — are
 * owned by `StorageEngine.migrations`; this module orchestrates the run and
 * derives all locking behavior from the presence of `acquireTransactionLock`
 * on the resolved engine, and all enforcement-suspension behavior from the
 * presence of `constraintSuspension`.
 * @see {@link readMigrations} for the filesystem-based data source.
 */
import { sql, type Name } from 'drizzle-orm';
import {
  getRawSqlExecutor,
  getStorageEngine,
  type MakaioDatabase,
  type RawSqlSession,
  type StorageDialect,
  type StorageEngine,
} from '@makaio/storage-drizzle';
import type { MigrationMeta } from './read-migrations.js';

/**
 * Default migration ledger table name for a dialect.
 *
 * Delegates to the registered engine: SQLite keeps Drizzle's historical
 * `__drizzle_migrations` name so existing ledgers keep matching, and the
 * Postgres engine declares `__makaio_migrations`, which can never collide
 * with a consumer-owned Drizzle ledger sharing the same database.
 * @param dialect - Storage dialect of the target database.
 * @returns Default ledger table name declared by the dialect's engine.
 */
export function resolveDefaultMigrationsTable(dialect: StorageDialect): string {
  return getStorageEngine(dialect).migrations.defaultLedgerTable;
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
  /** Engine serving the target database; owns all per-engine migration mechanics. */
  readonly engine: StorageEngine;
  /** Resolved ledger table name (engine default or caller-provided). */
  readonly tableName: string;
  /** Escaped identifier of the ledger table for statement interpolation. */
  readonly tableId: Name;
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
 * The engine's `beginTransactionStatement` opens the transaction; engines pin
 * isolation levels there when their ledger recheck protocol requires it (the
 * Postgres engine pins `READ COMMITTED` so the in-lock recheck snapshots
 * after lock acquisition — see its `beginTransactionStatement` rationale).
 *
 * Engines that declare `acquireTransactionLock` immediately take their
 * transaction-scoped cross-process lock inside every transaction the run
 * opens. A transaction-scoped lock cannot outlive its transaction, so
 * re-acquiring it per transaction is what serializes every ledger read and
 * write of concurrent multi-process runners; because the lock releases
 * automatically at COMMIT/ROLLBACK, every apply decision additionally
 * re-reads the ledger under its own lock
 * ({@link skipIfRecordedByConcurrentRunner}) instead of trusting the
 * run-level snapshot. Engines without the lock member (SQLite) take no lock:
 * their writes already serialize at the connection level within the
 * supported envelope.
 *
 * Cleanup contract: resolves with a usable locked transaction open, or rolls
 * the fresh transaction back before rethrowing when the lock acquisition
 * fails after BEGIN (lock timeout, administrative cancel during a contended
 * wait) — the session never leaves this helper inside an aborted transaction.
 * @param context - Run context carrying the session, engine, and ledger table.
 */
async function beginMigrationTransaction(context: MigrationRunContext): Promise<void> {
  const { migrations } = context.engine;
  await context.session.run(sql.raw(migrations.beginTransactionStatement));
  if (migrations.acquireTransactionLock) {
    try {
      await migrations.acquireTransactionLock(context.session, context.tableName);
    } catch (error) {
      await rollbackSwallowingErrors(context.session, { migrationsTable: context.tableName });
      throw error;
    }
  }
}

/**
 * Create the ledger table if absent and snapshot the applied migration hashes.
 *
 * On engines with a cross-process lock protocol both statements run inside
 * their own locked transaction so the snapshot cannot interleave with another
 * runner's in-flight ledger writes. The lock releases when the snapshot
 * transaction commits, so there the snapshot is only a fast path: each apply
 * decision re-validates against the ledger under its own lock
 * ({@link skipIfRecordedByConcurrentRunner}). On lock-free engines (SQLite)
 * both statements stay in autocommit, preserving the historical statement
 * flow.
 * @param context - Run context for the pinned session.
 * @returns Hashes already recorded in the ledger.
 */
async function snapshotAppliedHashes(context: MigrationRunContext): Promise<Set<string>> {
  const usesCrossProcessLock = context.engine.migrations.acquireTransactionLock !== undefined;
  if (usesCrossProcessLock) {
    await beginMigrationTransaction(context);
  }
  try {
    await context.session.run(sql.raw(context.engine.migrations.buildLedgerDdl(context.tableName)));
    const appliedRows = await context.session.all<{ hash: string }>(sql`SELECT hash FROM ${context.tableId}`);
    if (usesCrossProcessLock) {
      await context.session.run(sql.raw('COMMIT'));
    }
    return new Set(appliedRows.map((row) => row.hash));
  } catch (error) {
    if (usesCrossProcessLock) {
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
 * under the cross-process lock of the open transaction.
 *
 * Engines with a cross-process lock only: the run-level snapshot releases
 * its lock when the snapshot transaction commits, so it is stale relative to
 * runners that commit between the snapshot and this migration's transaction.
 * Re-reading the ledger row while holding the lock fully serializes the
 * apply/skip decision (sound because the engine's `beginTransactionStatement`
 * pins an isolation level that snapshots after lock acquisition) — a runner
 * that loses the race commits its empty transaction and skips cleanly
 * instead of failing on a duplicate object or the ledger's UNIQUE hash
 * constraint. Lock-free engines (SQLite) never re-read: their single-writer
 * semantics make the snapshot authoritative within the supported envelope,
 * and the statement stream stays byte-identical to the historical flow.
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
  const usesCrossProcessLock = context.engine.migrations.acquireTransactionLock !== undefined;
  if (!usesCrossProcessLock) {
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
 * the hash in a fresh BEGIN/COMMIT on the same pinned session — uniformly on
 * every engine; on SQLite the rolled-back transaction held only the failed
 * CREATE, so this flow is behaviorally identical to recording in place. On
 * engines with a cross-process lock the ROLLBACK also released that lock, so
 * the fresh transaction re-checks the ledger before inserting — a concurrent
 * runner may have recorded the same migration in the gap.
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
 * transaction, rolling back on any failure. On engines with a cross-process
 * lock the transaction first re-validates the ledger under that lock
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
        if (statementIndex === 0 && /^\s*CREATE\s/i.test(stmt) && context.engine.errors.isDuplicateObjectError(error)) {
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
 * Run one migration with the engine's constraint enforcement suspended when
 * the migration's statement stream asks for it.
 *
 * The suspend/restore statements bracket the migration's transaction from the
 * outside: an engine only needs this protocol when its enforcement switch is
 * connection-scoped and inert inside a transaction, so issuing it in the
 * statement stream — where generators put it — cannot work. Migrations that do
 * not request suspension run with enforcement untouched.
 *
 * `restoreStatement` runs in a `finally` so a failed migration cannot leave
 * the pinned session with enforcement disabled.
 * @param context - Run context for the pinned session.
 * @param migration - Migration whose statements declare the requirement.
 * @param apply - Applies the migration inside its own transaction(s).
 */
async function withConstraintSuspension(
  context: MigrationRunContext,
  migration: MigrationMeta,
  apply: () => Promise<void>,
): Promise<void> {
  const suspension = context.engine.migrations.constraintSuspension;
  if (!suspension?.isRequestedBy(migration.sql)) {
    await apply();
    return;
  }
  await context.session.run(sql.raw(suspension.suspendStatement));
  try {
    await apply();
  } finally {
    await context.session.run(sql.raw(suspension.restoreStatement));
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
 * pooled backend, standalone statements would stripe across connections.
 * Engines that declare `acquireTransactionLock` (Postgres) additionally take
 * their transaction-scoped cross-process lock inside every transaction the
 * run opens — with an isolation level pinned by the engine's
 * `beginTransactionStatement` — and re-validate the ledger under that lock
 * before applying or adopting, so concurrent multi-process runners serialize
 * their apply decisions: a runner that loses the race skips the migration
 * cleanly instead of racing the snapshot into a duplicate-object or
 * constraint failure.
 *
 * Engines that declare `constraintSuspension` (SQLite) additionally bracket a
 * migration that requests it with the engine's suspend/restore statements
 * outside the transaction — see {@link withConstraintSuspension}.
 *
 * Idempotent — safe to call on every startup.
 * @param db - Makaio database instance.
 * @param migrations - Ordered migration entries from {@link readMigrations}
 *   or from build-time embedding.
 * @param migrationsTable - Ledger table name. Defaults to the engine's
 *   declared ledger: `__drizzle_migrations` on SQLite, `__makaio_migrations`
 *   on Postgres.
 */
export async function applyMigrations(
  db: MakaioDatabase,
  migrations: MigrationMeta[],
  migrationsTable?: string,
): Promise<void> {
  const executor = getRawSqlExecutor(db);
  const engine = getStorageEngine(executor.dialect);
  const tableName = migrationsTable ?? engine.migrations.defaultLedgerTable;

  await executor.withSession(async (session) => {
    const context: MigrationRunContext = {
      session,
      engine,
      tableName,
      tableId: sql.identifier(tableName),
    };

    const appliedHashes = await snapshotAppliedHashes(context);

    for (const migration of migrations) {
      if (appliedHashes.has(migration.hash)) continue;
      await withConstraintSuspension(context, migration, () => applyMigrationInTransaction(context, migration));
      appliedHashes.add(migration.hash);
    }
  });
}
