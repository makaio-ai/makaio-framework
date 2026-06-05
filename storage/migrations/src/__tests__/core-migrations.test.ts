/**
 * Regression tests for the core migration set.
 *
 * Applies migrations read from the local `drizzle/` folder to an in-memory
 * SQLite database and asserts that important schema changes are present and
 * correctly formed.
 *
 * These are black-box regression guards: they verify the observable schema
 * produced by the SQL files, not the Drizzle TypeScript schema objects.
 */

import * as fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { readMigrations, type MigrationMeta } from '../read-migrations.js';
import { applyMigrations } from '../apply-migrations.js';

interface TableColumnInfo {
  readonly name: string;
  readonly notnull: number;
}

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

/**
 * Create an in-memory database, apply the selected package migrations, and run
 * a test callback against the migrated schema.
 * @param migrations - Migration entries to apply before the callback.
 * @param callback - Test body that receives the migrated database.
 * @returns The callback result.
 */
async function withMemoryDatabaseAtMigrations<TResult>(
  migrations: MigrationMeta[],
  callback: (db: MakaioDatabase) => Promise<TResult>,
): Promise<TResult> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });

  try {
    await applyMigrations(db, migrations);
    return await callback(db);
  } finally {
    close();
  }
}

/**
 * Read SQLite column metadata for a table.
 * @param db - Database connection to inspect.
 * @param tableName - Table whose columns should be read.
 * @returns Table column metadata keyed by column name.
 */
async function readTableColumns(
  db: MakaioDatabase,
  tableName: 'workflow_executions' | 'workflow_run_contexts',
): Promise<Map<string, TableColumnInfo>> {
  const rows = await db.all<TableColumnInfo>(sql.raw(`PRAGMA table_info(${tableName})`));
  return new Map(rows.map((row) => [row.name, row]));
}

/**
 * Locate a migration by tag and return the pre-migration set plus target entry.
 * @param migrations - Ordered migration entries.
 * @param tag - Tag of the migration under test.
 * @returns Migration entries before the target and the target migration.
 */
function splitBeforeMigration(
  migrations: MigrationMeta[],
  tag: string,
): { readonly before: MigrationMeta[]; readonly target: MigrationMeta } {
  const index = migrations.findIndex((migration) => migration.tag === tag);
  if (index === -1) {
    throw new Error(`Expected core migration '${tag}' to exist.`);
  }
  return { before: migrations.slice(0, index), target: migrations[index]! };
}

describe('core migrations', () => {
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

  it('preserves workflow rows while making inputs nullable and adding execution hints', async () => {
    const migrations = readMigrations();
    const migration = splitBeforeMigration(migrations, '0005_round_calypso');

    await withMemoryDatabaseAtMigrations(migration.before, async (db) => {
      await db.run(sql`
        INSERT INTO workflow_executions (
          id,
          workflow_id,
          coordinator_session_id,
          status,
          inputs,
          started_at,
          trigger_payload,
          scope_type
        )
        VALUES (
          'exec-before-0005',
          'workflow-before-0005',
          'session-before-0005',
          'running',
          '{"task":"review"}',
          1000,
          '{}',
          'global'
        )
      `);
      await db.run(sql`
        INSERT INTO workflow_run_contexts (
          execution_id,
          workflow_id,
          coordinator_session_id,
          source_kind,
          worker_manifest,
          inputs,
          config,
          trigger_payload,
          scope_type,
          cancel_subject,
          context,
          env,
          created_at
        )
        VALUES (
          'exec-before-0005',
          'workflow-before-0005',
          'session-before-0005',
          'definition',
          '{"packages":[]}',
          '{"task":"review"}',
          '{}',
          '{}',
          'global',
          'workflow.exec-before-0005.cancel',
          '{"repoPath":"/repo","platform":"darwin","arch":"arm64"}',
          '{}',
          1000
        )
      `);

      await applyMigrations(db, [migration.target]);

      const executionColumns = await readTableColumns(db, 'workflow_executions');
      const runContextColumns = await readTableColumns(db, 'workflow_run_contexts');

      expect(executionColumns.get('inputs')?.notnull).toBe(0);
      expect(runContextColumns.get('inputs')?.notnull).toBe(0);
      expect(runContextColumns.has('execution_hints')).toBe(true);

      const executionRows = await db.all<{ inputs: string | null }>(sql`
        SELECT inputs
        FROM workflow_executions
        WHERE id = 'exec-before-0005'
      `);
      const runContextRows = await db.all<{ inputs: string | null; execution_hints: string | null }>(sql`
        SELECT inputs, execution_hints
        FROM workflow_run_contexts
        WHERE execution_id = 'exec-before-0005'
      `);

      expect(executionRows).toEqual([{ inputs: '{"task":"review"}' }]);
      expect(runContextRows).toEqual([{ inputs: '{"task":"review"}', execution_hints: null }]);

      await db.run(sql`
        INSERT INTO workflow_executions (
          id,
          workflow_id,
          coordinator_session_id,
          status,
          inputs,
          started_at,
          trigger_payload,
          scope_type
        )
        VALUES (
          'exec-null-input',
          'workflow-null-input',
          'session-null-input',
          'running',
          NULL,
          2000,
          '{}',
          'global'
        )
      `);
      await db.run(sql`
        INSERT INTO workflow_run_contexts (
          execution_id,
          workflow_id,
          coordinator_session_id,
          source_kind,
          worker_manifest,
          inputs,
          config,
          trigger_payload,
          execution_hints,
          scope_type,
          cancel_subject,
          context,
          env,
          created_at
        )
        VALUES (
          'exec-null-input',
          'workflow-null-input',
          'session-null-input',
          'definition',
          '{"packages":[]}',
          NULL,
          '{}',
          '{}',
          '{"priority":"high"}',
          'global',
          'workflow.exec-null-input.cancel',
          '{"repoPath":"/repo","platform":"darwin","arch":"arm64"}',
          '{}',
          2000
        )
      `);

      const nullableRows = await db.all<{ execution_hints: string | null; inputs: string | null }>(sql`
        SELECT inputs, execution_hints
        FROM workflow_run_contexts
        WHERE execution_id = 'exec-null-input'
      `);
      expect(nullableRows).toEqual([{ inputs: null, execution_hints: '{"priority":"high"}' }]);
    });
  });

  it('marks existing workflow frame outputs and gate resume data during migration', async () => {
    const migrations = readMigrations();
    const migration = splitBeforeMigration(migrations, '0006_free_tiger_shark');

    await withMemoryDatabaseAtMigrations(migration.before, async (db) => {
      await db.run(sql`
        INSERT INTO workflow_executions (
          id,
          workflow_id,
          coordinator_session_id,
          status,
          inputs,
          started_at,
          trigger_payload,
          scope_type
        )
        VALUES (
          'exec-before-0006',
          'workflow-before-0006',
          'session-before-0006',
          'running',
          '{}',
          1000,
          '{}',
          'global'
        )
      `);
      await db.run(sql`
        INSERT INTO workflow_execution_frames (
          frame_id,
          execution_id,
          node_id,
          node_type,
          path,
          status,
          attempt,
          output
        )
        VALUES (
          'frame-output-before-0006',
          'exec-before-0006',
          'node-output',
          'station',
          '["frame-output-before-0006"]',
          'completed',
          0,
          '{"ok":true}'
        )
      `);
      await db.run(sql`
        INSERT INTO workflow_execution_frames (
          frame_id,
          execution_id,
          node_id,
          node_type,
          path,
          status,
          attempt,
          output
        )
        VALUES (
          'frame-absent-output-before-0006',
          'exec-before-0006',
          'node-absent-output',
          'station',
          '["frame-absent-output-before-0006"]',
          'running',
          0,
          NULL
        )
      `);
      await db.run(sql`
        INSERT INTO workflow_gate_instances (
          id,
          execution_id,
          node_id,
          frame_id,
          schema,
          status,
          resume_data,
          created_at
        )
        VALUES (
          'exec-before-0006:gate-with-resume:frame-gate-with-resume',
          'exec-before-0006',
          'gate-with-resume',
          'frame-gate-with-resume',
          '{}',
          'resumed',
          '{"approved":true}',
          1000
        )
      `);
      await db.run(sql`
        INSERT INTO workflow_gate_instances (
          id,
          execution_id,
          node_id,
          frame_id,
          schema,
          status,
          resume_data,
          created_at
        )
        VALUES (
          'exec-before-0006:waiting-gate:frame-waiting-gate',
          'exec-before-0006',
          'waiting-gate',
          'frame-waiting-gate',
          '{}',
          'waiting',
          NULL,
          1000
        )
      `);

      await applyMigrations(db, [migration.target]);

      const frameColumns = await db.all<TableColumnInfo>(sql.raw('PRAGMA table_info(workflow_execution_frames)'));
      const gateColumns = await db.all<TableColumnInfo>(sql.raw('PRAGMA table_info(workflow_gate_instances)'));
      expect(frameColumns.map((column) => column.name)).toContain('output_present');
      expect(gateColumns.map((column) => column.name)).toContain('resume_data_present');

      const frameRows = await db.all<{ frame_id: string; output_present: number }>(sql`
        SELECT frame_id, output_present
        FROM workflow_execution_frames
        WHERE execution_id = 'exec-before-0006'
        ORDER BY frame_id
      `);
      const gateRows = await db.all<{ node_id: string; resume_data_present: number }>(sql`
        SELECT node_id, resume_data_present
        FROM workflow_gate_instances
        WHERE execution_id = 'exec-before-0006'
        ORDER BY node_id
      `);

      expect(frameRows).toEqual([
        { frame_id: 'frame-absent-output-before-0006', output_present: 0 },
        { frame_id: 'frame-output-before-0006', output_present: 1 },
      ]);
      expect(gateRows).toEqual([
        { node_id: 'gate-with-resume', resume_data_present: 1 },
        { node_id: 'waiting-gate', resume_data_present: 0 },
      ]);
    });
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
