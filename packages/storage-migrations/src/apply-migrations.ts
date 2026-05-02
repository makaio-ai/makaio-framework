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
          try {
            await db.run(sql.raw(stmt));
          } catch (error) {
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
