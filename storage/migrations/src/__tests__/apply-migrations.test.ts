import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import {
  applyMigrations,
  buildBeginTransactionStatement,
  buildLedgerTableDdl,
  migrationAdvisoryLockKey,
  resolveDefaultMigrationsTable,
} from '../apply-migrations.js';

describe('applyMigrations', () => {
  it('rolls back the whole migration when one statement fails', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    try {
      await expect(
        applyMigrations(db, [
          {
            tag: '0001_atomicity',
            folderMillis: 1,
            hash: 'hash-1',
            bps: false,
            sql: [
              'CREATE TABLE atomic_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
              "INSERT INTO atomic_test (id, value) VALUES (1, 'ok')",
              'INSERT INTO missing_table (id) VALUES (1)',
            ],
          },
        ]),
      ).rejects.toThrow();

      const createdTables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'atomic_test'
      `);
      expect(createdTables).toEqual([]);

      const trackingTables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = '__drizzle_migrations'
      `);
      expect(trackingTables).toHaveLength(1);

      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([]);
    } finally {
      close();
    }
  });

  it('rejects a later CREATE conflict without recording the migration hash', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    try {
      await expect(
        applyMigrations(db, [
          {
            tag: '0001_later_create_conflict',
            folderMillis: 2,
            hash: 'hash-later-create-conflict',
            bps: false,
            sql: [
              'CREATE TABLE committed_before_conflict (id INTEGER PRIMARY KEY)',
              'CREATE TABLE committed_before_conflict (id INTEGER PRIMARY KEY)',
            ],
          },
        ]),
      ).rejects.toThrow();

      const createdTables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'committed_before_conflict'
      `);
      expect(createdTables).toEqual([]);

      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([]);
    } finally {
      close();
    }
  });

  it('applies a migration, creates the tracking row, and executes the DDL', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    try {
      await applyMigrations(db, [
        {
          tag: '0001_happy',
          folderMillis: 1000,
          hash: 'hash-happy-1',
          bps: false,
          sql: ['CREATE TABLE happy_test (id INTEGER PRIMARY KEY, label TEXT NOT NULL)'],
        },
      ]);

      // The DDL statement must have been executed.
      const createdTables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'happy_test'
      `);
      expect(createdTables).toHaveLength(1);

      // The tracking table must contain exactly one row for this migration.
      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([{ hash: 'hash-happy-1', created_at: 1000 }]);
    } finally {
      close();
    }
  });

  it('does not re-apply a migration that was already applied (idempotency)', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    const migration = {
      tag: '0001_idempotent',
      folderMillis: 2000,
      hash: 'hash-idempotent-1',
      bps: false,
      sql: ['CREATE TABLE idempotent_test (id INTEGER PRIMARY KEY)'],
    };

    try {
      await applyMigrations(db, [migration]);
      // Second call with the same migration — must be a no-op.
      await applyMigrations(db, [migration]);

      // The tracking table must still have exactly one row.
      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toHaveLength(1);
      expect(migrationRows[0]).toEqual({ hash: 'hash-idempotent-1', created_at: 2000 });
    } finally {
      close();
    }
  });

  it('rejects multi-statement adoption when the first CREATE target already exists', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    try {
      await rawSql.run(sql`CREATE TABLE adopted_test (id INTEGER PRIMARY KEY)`);

      await expect(
        applyMigrations(db, [
          {
            tag: '0001_adopt_existing_schema',
            folderMillis: 2500,
            hash: 'hash-adopt-existing',
            bps: false,
            sql: [
              'CREATE TABLE adopted_test (id INTEGER PRIMARY KEY)',
              'ALTER TABLE adopted_test ADD COLUMN unsafe_after_adoption TEXT',
            ],
          },
        ]),
      ).rejects.toThrow("Cannot adopt multi-statement migration '0001_adopt_existing_schema'");

      const columns = await rawSql.all<{ name: string }>(sql`PRAGMA table_info(adopted_test)`);
      expect(columns.map((column) => column.name)).toEqual(['id']);

      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([]);
    } finally {
      close();
    }
  });

  it('adopts a single-statement existing CREATE target', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    try {
      await rawSql.run(sql`CREATE TABLE adopted_single_test (id INTEGER PRIMARY KEY)`);

      await applyMigrations(db, [
        {
          tag: '0001_adopt_existing_single_schema',
          folderMillis: 2600,
          hash: 'hash-adopt-existing-single',
          bps: false,
          sql: ['CREATE TABLE adopted_single_test (id INTEGER PRIMARY KEY)'],
        },
      ]);

      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([{ hash: 'hash-adopt-existing-single', created_at: 2600 }]);
    } finally {
      close();
    }
  });

  it('applies a migration whose timestamp is earlier than an already-applied migration (multi-runner safety)', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    // Simulate first runner having applied a migration with a later timestamp.
    const migrationLater = {
      tag: '0002_later',
      folderMillis: 9000,
      hash: 'hash-later',
      bps: false,
      sql: ['CREATE TABLE later_table (id INTEGER PRIMARY KEY)'],
    };
    // Simulate second runner owning a migration with an earlier timestamp.
    const migrationEarlier = {
      tag: '0001_earlier',
      folderMillis: 1000,
      hash: 'hash-earlier',
      bps: false,
      sql: ['CREATE TABLE earlier_table (id INTEGER PRIMARY KEY)'],
    };

    try {
      // First runner applies its migration (timestamp 9000).
      await applyMigrations(db, [migrationLater]);

      // Second runner applies its migration (timestamp 1000 < 9000).
      // Under the old timestamp-based guard this would be silently skipped.
      await applyMigrations(db, [migrationEarlier]);

      // Both tables must exist — earlier_table must not have been skipped.
      const tables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('earlier_table', 'later_table')
        ORDER BY name ASC
      `);
      expect(tables.map((r) => r.name)).toEqual(['earlier_table', 'later_table']);

      // Tracking table must contain exactly two rows.
      const migrationRows = await rawSql.all<{ hash: string }>(
        sql`SELECT hash FROM __drizzle_migrations ORDER BY hash ASC`,
      );
      expect(migrationRows.map((r) => r.hash)).toEqual(['hash-earlier', 'hash-later']);
    } finally {
      close();
    }
  });

  it('applies only the new migration when called a second time with an additional entry', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    const migrationA = {
      tag: '0001_sequential_a',
      folderMillis: 3000,
      hash: 'hash-seq-a',
      bps: false,
      sql: ['CREATE TABLE seq_a (id INTEGER PRIMARY KEY)'],
    };
    const migrationB = {
      tag: '0002_sequential_b',
      folderMillis: 4000,
      hash: 'hash-seq-b',
      bps: false,
      sql: ['CREATE TABLE seq_b (id INTEGER PRIMARY KEY)'],
    };

    try {
      // First call: only A.
      await applyMigrations(db, [migrationA]);

      // Second call: A + B. Only B should be applied.
      await applyMigrations(db, [migrationA, migrationB]);

      // Both tables must exist.
      const tables = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('seq_a', 'seq_b')
        ORDER BY name ASC
      `);
      expect(tables.map((r) => r.name)).toEqual(['seq_a', 'seq_b']);

      // The tracking table must have exactly two rows — one per migration.
      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([
        { hash: 'hash-seq-a', created_at: 3000 },
        { hash: 'hash-seq-b', created_at: 4000 },
      ]);
    } finally {
      close();
    }
  });

  it('honors an explicit ledger table name instead of the dialect default', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });
    const rawSql = getRawSqlExecutor(db);

    try {
      await applyMigrations(
        db,
        [
          {
            tag: '0001_explicit_ledger',
            folderMillis: 5000,
            hash: 'hash-explicit-ledger',
            bps: false,
            sql: ['CREATE TABLE explicit_ledger_test (id INTEGER PRIMARY KEY)'],
          },
        ],
        'custom_migrations_ledger',
      );

      const migrationRows = await rawSql.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM custom_migrations_ledger ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([{ hash: 'hash-explicit-ledger', created_at: 5000 }]);

      // The dialect default must not be created when a name is provided.
      const defaultLedger = await rawSql.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = '__drizzle_migrations'
      `);
      expect(defaultLedger).toEqual([]);
    } finally {
      close();
    }
  });
});

/**
 * Statement-recording harness: a hand-rolled libsql handle wrapped in a proxy
 * that records every raw `run`/`all` statement text before delegating to the
 * real driver. `getRawSqlExecutor` synthesizes its SQLite executor over this
 * proxy (the documented fallback for unbranded handles), so the recorded
 * stream is exactly what `applyMigrations` executes against the real database.
 */
interface RecordingDb {
  /** Unwrapped handle for seeding and assertions outside the recording. */
  readonly real: LibSQLDatabase;
  /** Proxied handle to hand to `applyMigrations`. */
  readonly recordingDb: LibSQLDatabase;
  /** Statement texts in execution order. */
  readonly statements: string[];
  /** Close the underlying libsql client. */
  readonly close: () => void;
}

/**
 * Create an in-memory database whose raw statement stream is recorded.
 * @returns Real handle, recording proxy, the statement log, and a closer.
 */
function createRecordingDb(): RecordingDb {
  const real = drizzle({ connection: { url: ':memory:' } });
  const serializer = new SQLiteSyncDialect();
  const statements: string[] = [];
  const recordingDb = new Proxy(real, {
    get(target, property, receiver): unknown {
      if (property === 'run' || property === 'all') {
        return (query: SQL): unknown => {
          statements.push(serializer.sqlToQuery(query).sql);
          return property === 'run' ? target.run(query) : target.all(query);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { real, recordingDb, statements, close: () => real.$client.close() };
}

describe('applyMigrations statement flow (SQLite)', () => {
  it('keeps the ledger INSERT inside the migration transaction on the successful path', async () => {
    const { recordingDb, statements, close } = createRecordingDb();

    try {
      await applyMigrations(recordingDb, [
        {
          tag: '0001_recorded_happy',
          folderMillis: 10,
          hash: 'hash-recorded-happy',
          bps: false,
          sql: ['CREATE TABLE recorded_happy (id INTEGER PRIMARY KEY)'],
        },
      ]);

      // Pins the SQLite statement sequence: snapshot in autocommit (no
      // advisory lock, no extra transaction, no in-lock ledger recheck), then
      // one BEGIN/COMMIT holding both the migration statement and its ledger
      // row.
      expect(statements).toEqual([
        buildLedgerTableDdl('sqlite', '__drizzle_migrations'),
        'SELECT hash FROM "__drizzle_migrations"',
        'BEGIN',
        'CREATE TABLE recorded_happy (id INTEGER PRIMARY KEY)',
        'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
        'COMMIT',
      ]);
    } finally {
      close();
    }
  });

  it('adopts by rolling back the poisoned transaction and recording in a fresh one', async () => {
    const { real, recordingDb, statements, close } = createRecordingDb();

    try {
      // Seed through the unwrapped handle so the recording holds only the run.
      await real.run(sql`CREATE TABLE adoption_flow_test (id INTEGER PRIMARY KEY)`);

      await applyMigrations(recordingDb, [
        {
          tag: '0001_adoption_flow',
          folderMillis: 20,
          hash: 'hash-adoption-flow',
          bps: false,
          sql: ['CREATE TABLE adoption_flow_test (id INTEGER PRIMARY KEY)'],
        },
      ]);

      // The failed CREATE poisons an open Postgres transaction, so the
      // dialect-independent adoption flow must ROLLBACK before recording the
      // adopted hash in a fresh BEGIN/COMMIT on the same session. The fresh
      // transaction performs no ledger recheck on SQLite — that re-read is
      // Postgres-only, where the ROLLBACK released the advisory lock.
      expect(statements).toEqual([
        buildLedgerTableDdl('sqlite', '__drizzle_migrations'),
        'SELECT hash FROM "__drizzle_migrations"',
        'BEGIN',
        'CREATE TABLE adoption_flow_test (id INTEGER PRIMARY KEY)',
        'ROLLBACK',
        'BEGIN',
        'INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)',
        'COMMIT',
      ]);

      const migrationRows = await real.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([{ hash: 'hash-adoption-flow', created_at: 20 }]);
    } finally {
      close();
    }
  });
});

describe('postgres ledger shape (string-level pins until live conformance coverage)', () => {
  it('derives the default ledger table name per dialect', () => {
    expect(resolveDefaultMigrationsTable('sqlite')).toBe('__drizzle_migrations');
    expect(resolveDefaultMigrationsTable('postgres')).toBe('__makaio_migrations');
  });

  it('pins the sqlite ledger DDL to the historical Drizzle shape', () => {
    expect(buildLedgerTableDdl('sqlite', '__drizzle_migrations')).toBe(
      'CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (\n' +
        '      id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
        '      hash text NOT NULL,\n' +
        '      created_at numeric\n' +
        '    )',
    );
  });

  it('pins the postgres ledger DDL: identity primary key and UNIQUE hash', () => {
    expect(buildLedgerTableDdl('postgres', '__makaio_migrations')).toBe(
      'CREATE TABLE IF NOT EXISTS "__makaio_migrations" (\n' +
        '      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n' +
        '      hash text NOT NULL UNIQUE,\n' +
        '      created_at numeric\n' +
        '    )',
    );
  });

  it('pins the BEGIN statement per dialect: postgres pins READ COMMITTED for the in-lock recheck', () => {
    // Inheriting default_transaction_isolation would let an ambient
    // REPEATABLE READ default snapshot the transaction at the lock SELECT —
    // before the lock wait completes — blinding the in-lock ledger recheck.
    expect(buildBeginTransactionStatement('sqlite')).toBe('BEGIN');
    expect(buildBeginTransactionStatement('postgres')).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
  });

  it('pins the advisory lock key derivation as a cross-version contract', () => {
    // First 8 bytes (big-endian, signed) of SHA-256("makaio:migrations:<table>").
    expect(migrationAdvisoryLockKey('__makaio_migrations')).toBe(-9176243337112485871n);
    expect(migrationAdvisoryLockKey('__drizzle_migrations')).toBe(-8697586541560377660n);
  });
});
