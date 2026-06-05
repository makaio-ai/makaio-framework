/**
 * Filesystem-free migration applicator.
 *
 * Replicates Drizzle's libsql {@link migrate} logic but accepts
 * pre-resolved {@link MigrationMeta} entries instead of reading from
 * disk. This enables bundled environments (Electron asar) to embed
 * migration SQL at build time without temp-dir hacks.
 *
 * Uses only standard public Drizzle APIs so the migrator works with any
 * driver backed by {@link MakaioDatabase} (libsql today, BunSQLite later):
 * - `db.run()` with a sql template tag for DDL, DML, and transaction control
 * - `db.values()` with a sql template tag to read the migration tracking table
 * @see {@link readMigrations} for the filesystem-based data source.
 */
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import type { MigrationMeta } from './read-migrations.js';

/**
 * Strip SQL line comments and whitespace to detect comment-only segments.
 * @param stmt - Raw SQL statement text (may include `--` comments).
 * @returns The statement with all line comments and surrounding whitespace removed.
 */
function stripComments(stmt: string): string {
  return stmt.replace(/--.*$/gm, '').trim();
}

/**
 * Walk the error cause chain looking for an "already exists" SQLite error.
 * @param error - Error thrown by a DDL statement.
 * @returns `true` when the root cause is a schema-object-already-exists conflict.
 */
function isAlreadyExistsError(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (/already exists/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Apply pre-resolved migrations to a database.
 *
 * Creates the `__drizzle_migrations` tracking table if absent, reads all
 * previously applied migration hashes into a Set, then executes each
 * unapplied migration inside its own transaction so the schema/data change
 * and tracking row commit atomically.
 *
 * Deduplication is by hash (not by timestamp), making it safe for multiple
 * central-tier runners that share the same `__drizzle_migrations` tracking
 * table. A migration from a second runner with an earlier timestamp than the
 * latest migration from the first runner will still be applied correctly
 * because the decision is `!appliedHashes.has(migration.hash)`.
 *
 * Unlike storage handlers, migrations run during startup before the database
 * handle is published through `RuntimeSubjects.database` and before services
 * register bus handlers, so this phase has exclusive ownership of the
 * connection. Using explicit `BEGIN` / `COMMIT` control here is therefore safe
 * and prevents partial schema commits from being retried as if nothing happened
 * without depending on driver-specific transaction callback semantics.
 *
 * Idempotent — safe to call on every startup.
 * @param db - Makaio database instance.
 * @param migrations - Ordered migration entries from {@link readMigrations}
 *   or from build-time embedding.
 * @param migrationsTable - Tracking table name. Defaults to `__drizzle_migrations`.
 */
export async function applyMigrations(
  db: MakaioDatabase,
  migrations: MigrationMeta[],
  migrationsTable = '__drizzle_migrations',
): Promise<void> {
  const tableId = sql.identifier(migrationsTable);

  // Create tracking table (idempotent).
  await db.run(
    sql`CREATE TABLE IF NOT EXISTS ${tableId} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash text NOT NULL,
      created_at numeric
    )`,
  );

  // Query all previously applied migration hashes.
  const appliedRows = await db.values<[string]>(sql`SELECT hash FROM ${tableId}`);
  const appliedHashes = new Set(appliedRows.map((row) => row[0]));

  // Apply each unapplied migration atomically. Migrations own the connection
  // during startup, so a per-migration transaction is safe and keeps the
  // tracking table aligned with the actual schema/data changes.
  for (const migration of migrations) {
    if (!appliedHashes.has(migration.hash)) {
      await db.run(sql.raw('BEGIN'));
      try {
        for (const [statementIndex, stmt] of migration.sql.entries()) {
          if (!stripComments(stmt)) continue;
          try {
            await db.run(sql.raw(stmt));
          } catch (error) {
            if (statementIndex === 0 && /^\s*CREATE\s/i.test(stmt) && isAlreadyExistsError(error)) {
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
              // hash below without re-running the CREATE.
              break;
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

        try {
          await db.run(
            sql`INSERT INTO ${tableId} ("hash", "created_at") VALUES (${migration.hash}, ${migration.folderMillis})`,
          );
          await db.run(sql.raw('COMMIT'));
          appliedHashes.add(migration.hash);
        } catch (error) {
          console.error('[storage-migrations] Failed to finalize migration', {
            hash: migration.hash,
            folderMillis: migration.folderMillis,
            error,
          });
          throw error;
        }
      } catch (error) {
        try {
          await db.run(sql.raw('ROLLBACK'));
        } catch (rollbackError) {
          console.error('[storage-migrations] Failed to roll back migration transaction', {
            hash: migration.hash,
            folderMillis: migration.folderMillis,
            rollbackError,
          });
        }
        throw error;
      }
    }
  }
}
