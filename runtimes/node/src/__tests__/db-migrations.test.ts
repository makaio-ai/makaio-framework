import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
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
 */

/**
 * Assert that exactly one row for the given table name exists in sqlite_master.
 *
 * Fails the current test when the table is absent from the schema.
 * @param db - Drizzle SQLite database handle.
 * @param tableName - SQLite table name to check.
 */
async function assertTableExists(db: MakaioDatabase, tableName: string): Promise<void> {
  const rows = await db.all<{ name: string }>(sql`
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
  const rows = await db.all<{ name: string }>(sql`
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
      const managedBinaryTables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('client_binary_versions', 'client_binary_state')
        ORDER BY name
      `);

      expect(managedBinaryTables.map((t) => t.name)).toEqual(['client_binary_state', 'client_binary_versions']);

      const managedBinaryIndexes = await db.all<{ name: string }>(sql`
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
      const stateTableInfo = await db.all<{ name: string; dflt_value: string | null }>(sql`
        PRAGMA table_info(client_binary_state)
      `);

      expect(stateTableInfo.map((col) => col.name)).toEqual(['client_id', 'active_version', 'updated_at']);
    } finally {
      close();
    }
  });
});
