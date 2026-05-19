import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import { applyMigrations } from '../apply-migrations.js';

describe('applyMigrations', () => {
  it('rolls back the whole migration when one statement fails', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

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

      const createdTables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'atomic_test'
      `);
      expect(createdTables).toEqual([]);

      const trackingTables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = '__drizzle_migrations'
      `);
      expect(trackingTables).toHaveLength(1);

      const migrationRows = await db.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([]);
    } finally {
      close();
    }
  });

  it('rejects a later CREATE conflict without recording the migration hash', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

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

      const createdTables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'committed_before_conflict'
      `);
      expect(createdTables).toEqual([]);

      const migrationRows = await db.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([]);
    } finally {
      close();
    }
  });

  it('applies a migration, creates the tracking row, and executes the DDL', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

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
      const createdTables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'happy_test'
      `);
      expect(createdTables).toHaveLength(1);

      // The tracking table must contain exactly one row for this migration.
      const migrationRows = await db.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([{ hash: 'hash-happy-1', created_at: 1000 }]);
    } finally {
      close();
    }
  });

  it('does not re-apply a migration that was already applied (idempotency)', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

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
      const migrationRows = await db.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toHaveLength(1);
      expect(migrationRows[0]).toEqual({ hash: 'hash-idempotent-1', created_at: 2000 });
    } finally {
      close();
    }
  });

  it('adopts an existing CREATE target without executing later statements from that migration', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

    try {
      await db.run(sql`CREATE TABLE adopted_test (id INTEGER PRIMARY KEY)`);

      await applyMigrations(db, [
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
      ]);

      const columns = await db.all<{ name: string }>(sql`PRAGMA table_info(adopted_test)`);
      expect(columns.map((column) => column.name)).toEqual(['id']);

      const migrationRows = await db.all<{ hash: string; created_at: number }>(
        sql`SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
      );
      expect(migrationRows).toEqual([{ hash: 'hash-adopt-existing', created_at: 2500 }]);
    } finally {
      close();
    }
  });

  it('applies a migration whose timestamp is earlier than an already-applied migration (multi-runner safety)', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

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
      const tables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('earlier_table', 'later_table')
        ORDER BY name ASC
      `);
      expect(tables.map((r) => r.name)).toEqual(['earlier_table', 'later_table']);

      // Tracking table must contain exactly two rows.
      const migrationRows = await db.all<{ hash: string }>(
        sql`SELECT hash FROM __drizzle_migrations ORDER BY hash ASC`,
      );
      expect(migrationRows.map((r) => r.hash)).toEqual(['hash-earlier', 'hash-later']);
    } finally {
      close();
    }
  });

  it('applies only the new migration when called a second time with an additional entry', async () => {
    const { db, close } = await createDatabaseClient({ url: ':memory:' });

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
      const tables = await db.all<{ name: string }>(sql`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('seq_a', 'seq_b')
        ORDER BY name ASC
      `);
      expect(tables.map((r) => r.name)).toEqual(['seq_a', 'seq_b']);

      // The tracking table must have exactly two rows — one per migration.
      const migrationRows = await db.all<{ hash: string; created_at: number }>(
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
});
