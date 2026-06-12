/**
 * Database migrations for NodeRuntime session persistence.
 *
 * Uses Drizzle's migration system for schema changes. Full-text-search
 * provisioning is engine-owned: after the central chain is applied, the
 * handle's storage engine provisions its search index (the SQLite engine
 * creates its FTS5 virtual table and sync triggers at boot — Drizzle cannot
 * declare virtual tables — while the Postgres engine ships its tsvector
 * column through the regular migration chain and provisions nothing here).
 */
import { getDatabaseDialect, resolveStorageEngine, type MakaioDatabase } from '@makaio/storage-drizzle';
import { readMigrations } from '@makaio/storage-migrations';
import { applyMigrations } from '@makaio/storage-migrations/apply-migrations';

/** Options for applying framework central migrations. */
export interface RunMigrationsOptions {
  /**
   * Optional filesystem path to a bundled framework migrations directory.
   * Defaults to the bundled chain matching the handle's dialect.
   */
  readonly migrationsDir?: string;
}

/**
 * Run all database migrations.
 *
 * 1. Runs Drizzle-generated migrations for all framework tables
 * 2. Provisions the storage engine's full-text-search index (engine-owned)
 * @param db - Drizzle database instance
 * @param options - Optional migration source overrides for bundled hosts.
 */
export async function runMigrations(db: MakaioDatabase, options: RunMigrationsOptions = {}): Promise<void> {
  // The expected dialect is derived from the handle (not threaded through the
  // options): it makes the journal-dialect validation an always-on guard
  // rather than a caller opt-in, and it selects the reader's filesystem
  // default — with no explicit migrationsDir, the bundled chain matching the
  // handle's dialect is applied. Bundled hosts replace the migrations reader
  // with embedded constants that carry no journal; there the field is ignored
  // by design (desktop hosts are SQLite).
  const migrations = readMigrations({
    migrationsDir: options.migrationsDir,
    expectedDialect: getDatabaseDialect(db),
  });
  await applyMigrations(db, migrations);

  // Engine-owned search-index provisioning, idempotent on every boot.
  await resolveStorageEngine(db).fts.provisionSearchIndex(db);
}
