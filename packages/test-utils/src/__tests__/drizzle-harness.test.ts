/**
 * Tests for the drizzle test harness ({@link createTempDb} /
 * {@link createPluginTestDb}).
 *
 * All tests run against real temp-file SQLite databases created through the
 * production `createDatabaseClient` factory — no mocks.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRawSqlExecutor } from '@makaio/storage-drizzle';
import { createDbCleanup, createPluginTestDb, createRestartableTempDb, createTempDb } from '../drizzle-harness.js';

describe('createRestartableTempDb', () => {
  it('hands out independent connections that share one committed store', async () => {
    const store = createRestartableTempDb('harness-restartable');
    try {
      const first = await store.connect();
      await getRawSqlExecutor(first).run(sql`CREATE TABLE restartable_test (id TEXT PRIMARY KEY)`);
      await getRawSqlExecutor(first).run(sql`INSERT INTO restartable_test (id) VALUES ('committed')`);

      // A second connection is what a rebuilt component gets. It can only see
      // the row because the row was committed, which is the property every
      // restart suite built on this helper depends on.
      const second = await store.connect();
      expect(second).not.toBe(first);
      const rows = await getRawSqlExecutor(second).all<{ id: string }>(sql`SELECT id FROM restartable_test`);
      expect(rows).toEqual([{ id: 'committed' }]);
    } finally {
      await store.close();
    }
  });

  it('closes every connection it handed out and tolerates a repeated teardown', async () => {
    const store = createRestartableTempDb('harness-restartable-teardown');
    await store.connect();
    await store.connect();

    await store.close();
    // Teardown is drained rather than iterated, so a suite that closes in both
    // a failure path and its hook does not close a connection twice.
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('closes a controller connection set without removing committed state needed by a replacement', async () => {
    const store = createRestartableTempDb('harness-restartable-close-connections');
    try {
      const first = await store.connect();
      await getRawSqlExecutor(first).run(sql`CREATE TABLE restartable_close_test (id TEXT PRIMARY KEY)`);
      await getRawSqlExecutor(first).run(sql`INSERT INTO restartable_close_test (id) VALUES ('survives')`);

      await store.closeConnections();
      await expect(getRawSqlExecutor(first).run(sql`SELECT 1`)).rejects.toThrow();

      const replacement = await store.connect();
      const rows = await getRawSqlExecutor(replacement).all<{ id: string }>(sql`SELECT id FROM restartable_close_test`);
      expect(rows).toEqual([{ id: 'survives' }]);
    } finally {
      await store.close();
    }
  });
});

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

describe('createDbCleanup', () => {
  it('attempts both closers and removes database files when cleanup fails', () => {
    const dbPath = join(tmpdir(), `makaio-harness-cleanup-${crypto.randomUUID()}.db`);
    writeFileSync(dbPath, 'temporary database');
    const handlerFailure = new Error('handler cleanup failed');
    const closeFailure = new Error('database close failed');
    let closeCalled = false;
    const close = (): void => {
      closeCalled = true;
      throw closeFailure;
    };

    const cleanup = createDbCleanup(
      () => {
        throw handlerFailure;
      },
      close,
      dbPath,
    );

    expect(() => cleanup()).toThrow(AggregateError);
    expect(closeCalled).toBe(true);
    expect(existsSync(dbPath)).toBe(false);
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
