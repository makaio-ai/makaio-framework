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
import { getRawSqlExecutor, type MakaioDatabase, type RawSqlExecutor } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { readMigrations, type MigrationMeta } from '../read-migrations.js';
import { applyMigrations } from '../apply-migrations.js';

/**
 * SQLite `PRAGMA table_info` row subset used by these assertions. A type alias
 * (not an interface) so it satisfies the executor's `Record<string, unknown>`
 * row constraint.
 */
type TableColumnInfo = {
  readonly name: string;
  readonly notnull: number;
};

/**
 * Database access handed to migration test callbacks.
 */
interface MigrationTestDb {
  /** Database handle for `applyMigrations` and query-builder access. */
  readonly db: MakaioDatabase;
  /** Raw SQL executor for schema and data assertions. */
  readonly rawSql: RawSqlExecutor;
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
 * @param callback - Test body that receives the migrated database context.
 * @returns The callback result.
 */
async function withMigratedMemoryDatabase<TResult>(
  callback: (context: MigrationTestDb) => Promise<TResult>,
): Promise<TResult> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });

  try {
    await applyMigrations(db, readMigrations());
    return await callback({ db, rawSql: getRawSqlExecutor(db) });
  } finally {
    close();
  }
}

/**
 * Create an in-memory database, apply the selected package migrations, and run
 * a test callback against the migrated schema.
 * @param migrations - Migration entries to apply before the callback.
 * @param callback - Test body that receives the migrated database context.
 * @returns The callback result.
 */
async function withMemoryDatabaseAtMigrations<TResult>(
  migrations: MigrationMeta[],
  callback: (context: MigrationTestDb) => Promise<TResult>,
): Promise<TResult> {
  const { db, close } = await createDatabaseClient({ url: ':memory:' });

  try {
    await applyMigrations(db, migrations);
    return await callback({ db, rawSql: getRawSqlExecutor(db) });
  } finally {
    close();
  }
}

/**
 * Read SQLite column metadata for a table.
 * @param rawSql - Raw SQL executor for the database to inspect.
 * @param tableName - Table whose columns should be read.
 * @returns Table column metadata keyed by column name.
 */
async function readTableColumns(
  rawSql: RawSqlExecutor,
  tableName: 'workflow_executions' | 'workflow_run_contexts',
): Promise<Map<string, TableColumnInfo>> {
  const rows = await rawSql.all<TableColumnInfo>(sql.raw(`PRAGMA table_info(${tableName})`));
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

    await withMemoryDatabaseAtMigrations(migration.before, async ({ db, rawSql }) => {
      await rawSql.run(sql`
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
      await rawSql.run(sql`
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

      const executionColumns = await readTableColumns(rawSql, 'workflow_executions');
      const runContextColumns = await readTableColumns(rawSql, 'workflow_run_contexts');

      expect(executionColumns.get('inputs')?.notnull).toBe(0);
      expect(runContextColumns.get('inputs')?.notnull).toBe(0);
      expect(runContextColumns.has('execution_hints')).toBe(true);

      const executionRows = await rawSql.all<{ inputs: string | null }>(sql`
        SELECT inputs
        FROM workflow_executions
        WHERE id = 'exec-before-0005'
      `);
      const runContextRows = await rawSql.all<{ inputs: string | null; execution_hints: string | null }>(sql`
        SELECT inputs, execution_hints
        FROM workflow_run_contexts
        WHERE execution_id = 'exec-before-0005'
      `);

      expect(executionRows).toEqual([{ inputs: '{"task":"review"}' }]);
      expect(runContextRows).toEqual([{ inputs: '{"task":"review"}', execution_hints: null }]);

      await rawSql.run(sql`
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
      await rawSql.run(sql`
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

      const nullableRows = await rawSql.all<{ execution_hints: string | null; inputs: string | null }>(sql`
        SELECT inputs, execution_hints
        FROM workflow_run_contexts
        WHERE execution_id = 'exec-null-input'
      `);
      expect(nullableRows).toEqual([{ inputs: null, execution_hints: '{"priority":"high"}' }]);
    });
  });

  it('upgrades pre-0030 workflow rows while replacing deprecated execution fields', async () => {
    const migrations = readMigrations();
    const migration = splitBeforeMigration(migrations, '0030_remote-worker-execution');

    await withMemoryDatabaseAtMigrations(migration.before, async ({ db, rawSql }) => {
      await rawSql.run(sql`
        INSERT INTO workflow_definitions (
          id, name, description, root, input_schema, config_schema, output_schema,
          state, artifact, triggers, scope_type, scope_kind, scope_id, created_at,
          updated_at, canvas_layout, source, success_finalizer_id, execution_hints
        )
        VALUES (
          'workflow-before-0030', 'Workflow before 0030', 'preserved definition',
          '{"nodes":[]}', '{"type":"object"}', NULL, NULL, 'active', NULL, '[]',
          'global', '', '', 1000, 1001, NULL, '{"extension":"factory"}', NULL,
          '{"deprecated":true}'
        )
      `);
      await rawSql.run(sql`
        INSERT INTO workflow_executions (
          id, workflow_id, coordinator_session_id, status, inputs, started_at,
          trigger_payload, scope_type
        )
        VALUES (
          'execution-before-0030', 'workflow-before-0030', 'session-before-0030',
          'running', '{"task":"upgrade"}', 1002, '{"trigger":"manual"}', 'global'
        )
      `);
      await rawSql.run(sql`
        INSERT INTO workflow_run_contexts (
          execution_id, workflow_id, coordinator_session_id, source_kind, source_path,
          source_filename, source_code, definition_snapshot, worker_manifest, inputs,
          config, trigger_payload, artifact_ref, execution_hints, dispatch_metadata,
          scope_type, scope_kind, scope_id, cancel_subject, context, env, created_at,
          suspension_strategy, terminal_authority
        )
        VALUES (
          'execution-before-0030', 'workflow-before-0030', 'session-before-0030',
          'definition', '.factory/workflows/upgrade.ts', 'upgrade.ts', 'export default {}',
          '{"id":"workflow-before-0030"}', '{"packages":[]}', '{"task":"upgrade"}',
          '{"retries":1}', '{"trigger":"manual"}', '{"kind":"issue"}',
          '{"deprecated":true}', '{"runner":"github-actions"}', 'global', '', '',
          'workflow.execution-before-0030.cancel', '{"deprecated":true}',
          '{"PATH":"/bin"}', 1003, 'none', '{"claimed":true}'
        )
      `);

      await applyMigrations(db, [migration.target]);

      const definitionColumns = await rawSql.all<TableColumnInfo>(sql.raw('PRAGMA table_info(workflow_definitions)'));
      const runContextColumns = await readTableColumns(rawSql, 'workflow_run_contexts');
      expect(definitionColumns.map(({ name }) => name)).toEqual(
        expect.arrayContaining(['executable_source', 'requirements']),
      );
      expect(definitionColumns.map(({ name }) => name)).not.toContain('execution_hints');
      expect(runContextColumns.has('execution_hints')).toBe(false);
      expect(runContextColumns.has('context')).toBe(false);
      expect(runContextColumns.has('materialization_spec')).toBe(true);

      const definitions = await rawSql.all<{
        name: string;
        root: string;
        source: string | null;
        executable_source: string | null;
        requirements: string | null;
      }>(sql`
        SELECT name, root, source, executable_source, requirements
        FROM workflow_definitions
        WHERE id = 'workflow-before-0030'
      `);
      const runContexts = await rawSql.all<{
        workflow_id: string;
        source_path: string | null;
        source_code: string | null;
        dispatch_metadata: string | null;
        terminal_authority: string | null;
        materialization_spec: string | null;
      }>(sql`
        SELECT workflow_id, source_path, source_code, dispatch_metadata, terminal_authority, materialization_spec
        FROM workflow_run_contexts
        WHERE execution_id = 'execution-before-0030'
      `);

      expect(definitions).toEqual([
        {
          name: 'Workflow before 0030',
          root: '{"nodes":[]}',
          source: '{"extension":"factory"}',
          executable_source: null,
          requirements: null,
        },
      ]);
      expect(runContexts).toEqual([
        {
          workflow_id: 'workflow-before-0030',
          source_path: '.factory/workflows/upgrade.ts',
          source_code: 'export default {}',
          dispatch_metadata: '{"runner":"github-actions"}',
          terminal_authority: '{"claimed":true}',
          materialization_spec: null,
        },
      ]);
    });
  });

  it('marks existing workflow frame outputs and gate resume data during migration', async () => {
    const migrations = readMigrations();
    const migration = splitBeforeMigration(migrations, '0006_free_tiger_shark');

    await withMemoryDatabaseAtMigrations(migration.before, async ({ db, rawSql }) => {
      await rawSql.run(sql`
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
      await rawSql.run(sql`
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
      await rawSql.run(sql`
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
      await rawSql.run(sql`
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
      await rawSql.run(sql`
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

      const frameColumns = await rawSql.all<TableColumnInfo>(sql.raw('PRAGMA table_info(workflow_execution_frames)'));
      const gateColumns = await rawSql.all<TableColumnInfo>(sql.raw('PRAGMA table_info(workflow_gate_instances)'));
      expect(frameColumns.map((column) => column.name)).toContain('output_present');
      expect(gateColumns.map((column) => column.name)).toContain('resume_data_present');

      const frameRows = await rawSql.all<{ frame_id: string; output_present: number }>(sql`
        SELECT frame_id, output_present
        FROM workflow_execution_frames
        WHERE execution_id = 'exec-before-0006'
        ORDER BY frame_id
      `);
      const gateRows = await rawSql.all<{ node_id: string; resume_data_present: number }>(sql`
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
    await withMigratedMemoryDatabase(async ({ rawSql }) => {
      const tables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'client_binary_versions'
      `);

      expect(tables).toHaveLength(1);
    });
  });

  it('client_binary_state table exists after all migrations', async () => {
    await withMigratedMemoryDatabase(async ({ rawSql }) => {
      const tables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'client_binary_state'
      `);

      expect(tables).toHaveLength(1);
    });
  });

  it('client_runtimes table exists after all migrations', async () => {
    await withMigratedMemoryDatabase(async ({ rawSql }) => {
      const tables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'client_runtimes'
      `);

      expect(tables).toHaveLength(1);
    });
  });

  it('uq_client_binary_versions_client_version unique index exists', async () => {
    await withMigratedMemoryDatabase(async ({ rawSql }) => {
      const indexes = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index' AND name = 'uq_client_binary_versions_client_version'
      `);

      expect(indexes).toHaveLength(1);
    });
  });

  it('client_binary_state stores active-version state', async () => {
    await withMigratedMemoryDatabase(async ({ rawSql }) => {
      await rawSql.run(sql`
        INSERT INTO client_binary_state (client_id, active_version, updated_at)
        VALUES ('test-client', '1.0.0', 1000)
      `);

      const rows = await rawSql.all<{ active_version: string }>(sql`
        SELECT active_version
        FROM client_binary_state
        WHERE client_id = 'test-client'
      `);

      expect(rows).toHaveLength(1);
      expect(rows[0]?.active_version).toBe('1.0.0');
    });
  });
});
