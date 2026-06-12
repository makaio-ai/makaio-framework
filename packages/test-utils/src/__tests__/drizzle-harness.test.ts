/**
 * Tests for the drizzle test harness ({@link createTempDb} /
 * {@link createPluginTestDb}).
 *
 * All tests run against real temp-file SQLite databases created through the
 * production `createDatabaseClient` factory — no mocks.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createPluginTestDb, createTempDb } from '../drizzle-harness.js';

describe('createTempDb', () => {
  it('exec runs hand-written DDL/DML through the executor and reports rowsAffected', async () => {
    const ctx = await createTempDb('harness-exec');
    try {
      await ctx.exec(sql`CREATE TABLE harness_exec_test (id TEXT PRIMARY KEY)`);

      const insert = await ctx.exec(sql`INSERT INTO harness_exec_test (id) VALUES ('a'), ('b')`);
      expect(insert.rowsAffected).toBe(2);

      // Row-returning reads go through the executor resolved off the handle.
      const rows = await getRawSqlExecutor(ctx.db).all<{ id: string }>(
        sql`SELECT id FROM harness_exec_test ORDER BY id`,
      );
      expect(rows).toEqual([{ id: 'a' }, { id: 'b' }]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe('createPluginTestDb', () => {
  it('applies schemas through the executor, supports exec, and clearData still wipes tables', async () => {
    const ctx = await createPluginTestDb({
      name: 'harness-plugin-exec',
      schemas: [sql`CREATE TABLE plugin_exec_test (id TEXT PRIMARY KEY)`],
      tables: ['plugin_exec_test'],
      registerHandlers: () => () => {},
    });
    try {
      const insert = await ctx.exec(sql`INSERT INTO plugin_exec_test (id) VALUES ('seeded')`);
      expect(insert.rowsAffected).toBe(1);

      await ctx.clearData();

      const rows = await getRawSqlExecutor(ctx.db).all<{ id: string }>(sql`SELECT id FROM plugin_exec_test`);
      expect(rows).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
