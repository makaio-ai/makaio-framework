/**
 * Transaction boundaries and isolation of the `bun:sqlite` client.
 *
 * Under Bun the SQLite client issues BEGIN/COMMIT/ROLLBACK on the connection
 * itself, so a failure at COMMIT must not leave that single connection inside
 * an open transaction. Because that connection is the handle's only one,
 * statements issued on the handle from outside an open transaction must not
 * run inside it. The cross-driver transaction contract is covered by the
 * storage conformance suite's Bun lane.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createDatabaseClient, type DatabaseClient } from '../client';
import { getRawSqlExecutor } from '../raw-sql';
import { executeTransaction } from '../transaction';

/** Single-column table the isolation cases write to. */
const t = sqliteTable('t', { id: text('id').primaryKey() });

/**
 * Yield microtask turns so other async work interleaves with the caller.
 * @param hops - Number of microtask turns to yield before resolving.
 */
async function yieldMicrotasks(hops: number): Promise<void> {
  for (let hop = 0; hop < hops; hop++) await Promise.resolve();
}

/**
 * Wait for one macrotask turn.
 */
async function yieldMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1));
}

describe('bun:sqlite in-memory databases', () => {
  // The libsql driver rejects these URLs because a libsql transaction takes over
  // the connection. bun:sqlite keeps one connection for the handle's whole
  // life, so the database survives transactions and every spelling is served.
  it.each([
    ':memory:',
    'file::memory:',
    'file::memory:?cache=shared',
    'file:memdb?mode=memory&cache=shared',
  ])('keeps %s across transactions without creating a file', async (url) => {
    const client = await createDatabaseClient({ url });
    try {
      const raw = getRawSqlExecutor(client.db);
      await raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
      await executeTransaction(client.db, async (tx) => {
        await tx.run(sql`INSERT INTO t (id) VALUES ('committed')`);
      });
      await expect(
        executeTransaction(client.db, async (tx) => {
          await tx.run(sql`INSERT INTO t (id) VALUES ('rolled-back')`);
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');

      expect(await raw.all(sql`SELECT id FROM t`)).toEqual([{ id: 'committed' }]);
      // bun:sqlite would create a file named after the URL's remainder.
      expect(existsSync(url.replace(/^file:/, ''))).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe('bun:sqlite initialization failure', () => {
  it('closes the connection of a handle that failed to initialize and keeps the original error', async () => {
    // The first PRAGMA of a file-backed handle fails on a file that is no
    // SQLite database, after the connection was already opened.
    const databaseFile = join(tmpdir(), `makaio-bun-init-failure-${crypto.randomUUID()}.db`);
    writeFileSync(databaseFile, 'this file is not a SQLite database '.repeat(8));
    const closeConnection = spyOn(Database.prototype, 'close');
    try {
      await expect(createDatabaseClient({ url: `file:${databaseFile}` })).rejects.toMatchObject({
        message: expect.stringContaining('PRAGMA journal_mode'),
        cause: { message: expect.stringMatching(/not a database/i) },
      });

      expect(closeConnection).toHaveBeenCalledTimes(1);
    } finally {
      closeConnection.mockRestore();
      rmSync(databaseFile, { force: true });
    }
  });
});

describe('bun:sqlite transaction boundaries', () => {
  let client: DatabaseClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it('rolls back and leaves the connection usable when COMMIT fails', async () => {
    client = await createDatabaseClient({ url: ':memory:' });
    const { db } = client;
    const raw = getRawSqlExecutor(db);
    await raw.run(sql`CREATE TABLE parent (id TEXT PRIMARY KEY)`);
    await raw.run(
      sql`CREATE TABLE child (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED
      )`,
    );

    // A deferred foreign key is only checked at COMMIT: the callback resolves
    // and the commit itself is what fails.
    await expect(
      executeTransaction(db, async (tx) => {
        await tx.run(sql`INSERT INTO parent (id) VALUES ('rolled-back')`);
        await tx.run(sql`INSERT INTO child (id, parent_id) VALUES ('orphan', 'missing')`);
      }),
    ).rejects.toThrow(/FOREIGN KEY/);

    await raw.run(sql`INSERT INTO parent (id) VALUES ('plain')`);
    await executeTransaction(db, async (tx) => {
      await tx.run(sql`INSERT INTO parent (id) VALUES ('transaction')`);
    });

    const rows = await raw.all<{ id: string }>(sql`SELECT id FROM parent ORDER BY id`);
    expect(rows).toEqual([{ id: 'plain' }, { id: 'transaction' }]);
  });

  it('keeps statements from outside an open transaction out of it', async () => {
    // Each hop count lands the outside statements at a different point of the
    // transaction: before BEGIN, between its statements, or while it awaits a
    // timer. None may join the transaction or see its uncommitted rows.
    for (let hops = 0; hops <= 8; hops++) {
      client = await createDatabaseClient({ url: ':memory:' });
      const { db } = client;
      const raw = getRawSqlExecutor(db);
      await raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);

      const outside = async (): Promise<string[]> => {
        await yieldMicrotasks(hops);
        await db.insert(t).values({ id: 'outside' });
        const seen = await db.select().from(t).orderBy(t.id);
        return seen.map((row) => row.id);
      };
      const [transaction, outsideResult] = await Promise.allSettled([
        executeTransaction(db, async (tx) => {
          await tx.run(sql`INSERT INTO t (id) VALUES ('tx-1')`);
          await yieldMacrotask();
          await tx.run(sql`INSERT INTO t (id) VALUES ('tx-2')`);
          throw new Error('forced rollback');
        }),
        outside(),
      ]);

      expect(transaction.status).toBe('rejected');
      // The outside write was confirmed, so it must have persisted.
      expect(outsideResult).toEqual({ status: 'fulfilled', value: ['outside'] });
      const rows = await raw.all<{ id: string }>(sql`SELECT id FROM t ORDER BY id`);
      expect({ hops, rows }).toEqual({ hops, rows: [{ id: 'outside' }] });

      await client.close();
      client = undefined;
    }
  });

  it('reads single rows through the deferred statements', async () => {
    client = await createDatabaseClient({ url: ':memory:' });
    const { db } = client;
    await getRawSqlExecutor(db).run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    await db.insert(t).values({ id: 'one' });

    expect(await db.select().from(t).get()).toEqual({ id: 'one' });
    expect(await db.select().from(t).where(sql`id = 'missing'`).get()).toBeUndefined();
  });

  it('runs statements the callback issues on the handle itself inside the transaction', async () => {
    client = await createDatabaseClient({ url: ':memory:' });
    const { db } = client;
    const raw = getRawSqlExecutor(db);
    await raw.run(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);

    // Work the callback starts belongs to the transaction even when it uses
    // `db` instead of `tx`; it must neither wait for the transaction (which
    // would never settle) nor escape its rollback.
    await expect(
      executeTransaction(db, async (tx) => {
        await tx.run(sql`INSERT INTO t (id) VALUES ('tx')`);
        await yieldMacrotask();
        await raw.run(sql`INSERT INTO t (id) VALUES ('handle')`);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    expect(await raw.all(sql`SELECT id FROM t`)).toEqual([]);
  });
});
