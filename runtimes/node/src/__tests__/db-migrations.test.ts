import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor, type MakaioDatabase } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { getMigrationsFolder } from '@makaio/storage-migrations';
import { createPgBrandedTestDb } from '@makaio/test-utils/drizzle-harness';
import { runMigrations } from '@makaio/runtime-node';

/**
 * Verifies that runMigrations applies the framework-tier migrations correctly.
 *
 * Only framework tables (those declared in `\@makaio/storage-migrations`) are
 * asserted here. Extension-owned tables are applied later through loaded
 * packages that declare `storage.migrations`; they are not part of the
 * framework runMigrations call.
 *
 * Note: `harness_definitions` is a framework-tier table (declared in
 * `\@makaio/services-core`) and is therefore created by runMigrations.
 *
 * Postgres-gating tests use the shared Postgres-branded test double from
 * `\@makaio/test-utils/drizzle-harness` — `pg` is not installed here, so the
 * fake executor records statements while everything above it runs real code.
 */

/**
 * Assert that exactly one row for the given table name exists in sqlite_master.
 *
 * Fails the current test when the table is absent from the schema.
 * @param db - Drizzle SQLite database handle.
 * @param tableName - SQLite table name to check.
 */
async function assertTableExists(db: MakaioDatabase, tableName: string): Promise<void> {
  const rows = await getRawSqlExecutor(db).all<{ name: string }>(sql`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ${tableName}
  `);
  expect(rows).toHaveLength(1);
}

/**
 * Assert that no sqlite_master row exists for the given table name.
 * @param db - Drizzle SQLite database handle.
 * @param tableName - SQLite table name to check.
 */
async function assertTableAbsent(db: MakaioDatabase, tableName: string): Promise<void> {
  const rows = await getRawSqlExecutor(db).all<{ name: string }>(sql`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ${tableName}
  `);
  expect(rows).toHaveLength(0);
}

describe('runMigrations', () => {
  it('creates the expected post-migration schema', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

    try {
      await runMigrations(db);

      // Core session tables — declared in @makaio/services-core
      await assertTableExists(db, 'sessions');
      await assertTableExists(db, 'messages');
      await assertTableExists(db, 'messages_fts');
      await assertTableExists(db, 'agents');
      await assertTableAbsent(db, 'artifacts_revisions_fts');

      // Harness table — declared in @makaio/services-core (framework tier)
      await assertTableExists(db, 'harness_definitions');

      // Client runtime tables — declared in @makaio/subsystem-client
      await assertTableExists(db, 'client_runtimes');

      // Managed binary tables — declared in @makaio/subsystem-client
      const rawSql = getRawSqlExecutor(db);
      const managedBinaryTables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('client_binary_versions', 'client_binary_state')
        ORDER BY name
      `);

      expect(managedBinaryTables.map((t) => t.name)).toEqual(['client_binary_state', 'client_binary_versions']);

      const managedBinaryIndexes = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'uq_client_binary_versions_client_version'
          )
        ORDER BY name
      `);

      expect(managedBinaryIndexes.map((i) => i.name)).toEqual(['uq_client_binary_versions_client_version']);

      // Verify the active-version state schema remains minimal.
      const stateTableInfo = await rawSql.all<{ name: string; dflt_value: string | null }>(sql`
        PRAGMA table_info(client_binary_state)
      `);

      expect(stateTableInfo.map((col) => col.name)).toEqual(['client_id', 'active_version', 'updated_at']);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------
// PG-dialect gating tests
// ---------------------------------------------------------------------------

describe('runMigrations (postgres dialect gating)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-pg-migrations-'));
    // A minimal postgresql journal with zero entries; no .sql files needed.
    await fs.mkdir(path.join(tmpDir, 'meta'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('skips FTS5 setup on postgres handles', async () => {
    const { db, statements } = createPgBrandedTestDb();

    await runMigrations(db, { migrationsDir: tmpDir });

    // No FTS5 DDL should have been sent to the executor.
    const joined = statements.join('\n');
    expect(joined).not.toContain('messages_fts');
    expect(joined).not.toContain('CREATE VIRTUAL TABLE');

    // The PG ledger DDL must have run (applyMigrations exercised real code
    // through the fake executor — not a mock of it).
    expect(joined).toContain('__makaio_migrations');
  });

  it('applies the bundled postgres chain when no migrationsDir is given', async () => {
    const { db, statements } = createPgBrandedTestDb();

    // Zero options: the reader's filesystem default must be the bundled chain
    // matching the handle's dialect — not the SQLite chain, whose journal the
    // always-on dialect guard would reject.
    await runMigrations(db);

    const joined = statements.join('\n');
    expect(joined).toContain('__makaio_migrations');
    // Postgres-only DDL proves the drizzle-postgres chain was read.
    expect(joined).toContain('tsvector');
    expect(joined).not.toContain('CREATE VIRTUAL TABLE');
  });

  it('rejects a sqlite journal on postgres handles with MigrationDialectMismatchError', async () => {
    const { db } = createPgBrandedTestDb();

    // Point the PG-branded handle at the real SQLite chain.
    const sqliteMigrationsDir = getMigrationsFolder('sqlite');

    let thrown: unknown;
    try {
      await runMigrations(db, { migrationsDir: sqliteMigrationsDir });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    // Match by name — not instanceof — bundled copies share no class identity.
    expect((thrown as Error).name).toBe('MigrationDialectMismatchError');
  });
});
