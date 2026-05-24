/**
 * Regression tests for the core migration set.
 *
 * Applies all migrations read from the local `drizzle/` folder to an
 * in-memory SQLite database and asserts that the managed-binary tables and
 * indexes are present and correctly formed.
 *
 * These are black-box regression guards: they verify the observable schema
 * produced by the SQL files, not the Drizzle TypeScript schema objects.
 */

import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { readMigrations } from '../read-migrations.js';
import { applyMigrations } from '../apply-migrations.js';

/**
 * Read a Drizzle metadata JSON file from the package-local `drizzle/meta`
 * directory.
 * @param filename - Metadata filename to read
 * @returns Parsed JSON metadata
 */
async function readMigrationMeta(filename: string): Promise<Record<string, unknown>> {
  const url = new URL(`../../drizzle/meta/${filename}`, import.meta.url);
  return JSON.parse(await fs.readFile(url, 'utf-8')) as Record<string, unknown>;
}

/**
 * Create an in-memory database, apply the package migrations, and run a test
 * callback against the migrated schema.
 * @param callback - Test body that receives the migrated database.
 * @returns The callback result.
 */
async function withMigratedMemoryDatabase<TResult>(
  callback: (db: MakaioDatabase) => Promise<TResult>,
): Promise<TResult> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });

  try {
    await applyMigrations(db, readMigrations());
    return await callback(db);
  } finally {
    close();
  }
}

describe('core migrations — managed binary tables', () => {
  it('reads all migrations without error and includes managed-binary DDL', () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThan(0);

    const migrationSql = migrations.flatMap((migration) => migration.sql).join('\n');
    expect(migrationSql).toContain('CREATE TABLE `client_binary_versions`');
    expect(migrationSql).toContain('CREATE TABLE `client_binary_state`');
    expect(migrationSql).toContain('CREATE TABLE `client_runtimes`');
  });

  it('keeps Drizzle metadata aligned with the managed-binary migration', async () => {
    const migrations = readMigrations();
    const journal = await readMigrationMeta('_journal.json');
    const entries = journal['entries'];
    expect(Array.isArray(entries)).toBe(true);
    if (!Array.isArray(entries)) {
      throw new Error('Expected Drizzle journal entries to be an array');
    }
    const latestEntry = entries.at(-1);
    if (typeof latestEntry !== 'object' || latestEntry === null) {
      throw new Error('Expected latest Drizzle journal entry to be an object');
    }
    const latestRecord = latestEntry as Record<string, unknown>;
    if (typeof latestRecord['idx'] !== 'number' || typeof latestRecord['tag'] !== 'string') {
      throw new Error('Expected latest Drizzle journal entry to include numeric idx and string tag');
    }
    expect(latestRecord['tag']).toBe(migrations.at(-1)?.tag);

    const snapshot = await readMigrationMeta(`${String(latestRecord['idx']).padStart(4, '0')}_snapshot.json`);
    const tables = snapshot['tables'] as Record<
      string,
      { columns: Record<string, unknown>; indexes: Record<string, unknown> }
    >;
    expect(Object.keys(tables)).toContain('client_runtimes');
    expect(Object.keys(tables)).toContain('client_binary_versions');
    expect(Object.keys(tables)).toContain('client_binary_state');
    expect(Object.keys(tables['client_binary_versions']!.indexes)).toEqual(
      expect.arrayContaining(['uq_client_binary_versions_client_version']),
    );
    expect(Object.keys(tables['client_binary_state']!.columns).sort()).toEqual([
      'active_version',
      'client_id',
      'updated_at',
    ]);
  });

  it('applies all migrations to :memory: without error', async () => {
    await expect(withMigratedMemoryDatabase(async () => undefined)).resolves.toBeUndefined();
  });

  it('client_binary_versions table exists after all migrations', async () => {
    await withMigratedMemoryDatabase(async (db) => {
      const tables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'client_binary_versions'
      `);

      expect(tables).toHaveLength(1);
    });
  });

  it('client_binary_state table exists after all migrations', async () => {
    await withMigratedMemoryDatabase(async (db) => {
      const tables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'client_binary_state'
      `);

      expect(tables).toHaveLength(1);
    });
  });

  it('client_runtimes table exists after all migrations', async () => {
    await withMigratedMemoryDatabase(async (db) => {
      const tables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'client_runtimes'
      `);

      expect(tables).toHaveLength(1);
    });
  });

  it('uq_client_binary_versions_client_version unique index exists', async () => {
    await withMigratedMemoryDatabase(async (db) => {
      const indexes = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'uq_client_binary_versions_client_version'
      `);

      expect(indexes).toHaveLength(1);
    });
  });

  it('client_binary_state stores active-version state', async () => {
    await withMigratedMemoryDatabase(async (db) => {
      await db.run(sql`
        INSERT INTO client_binary_state (client_id, active_version, updated_at)
        VALUES ('test-client', '1.0.0', 1000)
      `);

      const rows = await db.all<{ active_version: string }>(sql`
        SELECT active_version
        FROM client_binary_state
        WHERE client_id = 'test-client'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.active_version).toBe('1.0.0');
    });
  });
});
