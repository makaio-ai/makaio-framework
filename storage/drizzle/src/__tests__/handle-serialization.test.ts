/**
 * Per-handle serialization and connection settings of SQLite handles.
 *
 * Runs on every supported runtime/driver: under Node.js the handle is backed
 * by `@libsql/client`, under Bun (see `handle-serialization.bun.test.ts`) by
 * `bun:sqlite`. Both must honor one contract: while a transaction (or a raw
 * `BEGIN` session) is open on a handle, statements issued from outside it wait
 * for it instead of joining it or failing with SQLITE_BUSY, and every
 * connection of the handle carries the same connection settings.
 *
 * File-backed databases are used throughout: libsql opens a fresh connection
 * after each transaction, which only a file shares between connections.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { executeTransaction } from '../transaction';
import { pause, useHandleFixture, type Handle } from './handle-fixture';

/** Drizzle table over the `t (id)` table every case creates. */
const tTable = sqliteTable('t', { id: text('id').primaryKey() });

describe('SQLite handle serialization', () => {
  const { openHandle, readIds } = useHandleFixture('handle-serialization');

  /**
   * Read the connection settings a statement on the handle currently runs with.
   * @param handle - Handle to read through.
   * @returns The busy timeout in milliseconds and the foreign key enforcement flag.
   */
  async function readConnectionSettings(handle: Handle): Promise<{ busyTimeout: number; foreignKeys: number }> {
    const read = async (pragma: string): Promise<number> => {
      const rows = await handle.raw.all<Record<string, unknown>>(sql.raw(`PRAGMA ${pragma}`));
      return Number(Object.values(rows[0] ?? {})[0]);
    };
    return { busyTimeout: await read('busy_timeout'), foreignKeys: await read('foreign_keys') };
  }

  it('applies the connection settings to every connection of the handle', async () => {
    const handle = await openHandle();
    const expected = { busyTimeout: 5000, foreignKeys: 1 };
    expect(await readConnectionSettings(handle)).toEqual(expected);

    // libsql opens a new connection for the statements after each transaction.
    for (let round = 0; round < 3; round++) {
      await executeTransaction(handle.db, async (tx) => {
        await tx.run(sql`SELECT 1`);
      });
      expect({ round, settings: await readConnectionSettings(handle) }).toEqual({ round, settings: expected });
    }

    await expect(
      executeTransaction(handle.db, async () => {
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');
    expect(await readConnectionSettings(handle)).toEqual(expected);
  });

  it('makes statements from outside an open transaction wait for it', async () => {
    const handle = await openHandle();
    const events: string[] = [];
    const inTransaction = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const transaction = executeTransaction(handle.db, async (tx) => {
      await tx.run(sql`INSERT INTO t (id) VALUES ('tx')`);
      inTransaction.resolve();
      await release.promise;
      events.push('transaction:end');
      throw new Error('forced rollback');
    });
    const settled = transaction.catch((error: unknown) => error);
    await inTransaction.promise;

    // Neither the write nor the read may run while the transaction is open:
    // no SQLITE_BUSY, no event loop stall, no visibility of its writes.
    const write = handle.raw.run(sql`INSERT INTO t (id) VALUES ('outside')`).then(() => events.push('write:done'));
    const read = readIds(handle).then((ids) => {
      events.push('read:done');
      return ids;
    });
    await pause();
    expect(events).toEqual([]);

    release.resolve();
    expect(await settled).toEqual(new Error('forced rollback'));
    await write;
    // Queued behind the transaction: its rolled-back row is gone, the write is in.
    expect(await read).toEqual(['outside']);
    expect(events).toEqual(['transaction:end', 'write:done', 'read:done']);
    expect(await readIds(handle)).toEqual(['outside']);
  });

  it('keeps uncommitted DDL out of sight of statements from outside the transaction', async () => {
    const handle = await openHandle();
    await handle.raw.run(sql`INSERT INTO t (id) VALUES ('before')`);
    const dropped = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const transaction = executeTransaction(handle.db, async (tx) => {
      await tx.run(sql`DROP TABLE t`);
      dropped.resolve();
      await release.promise;
      throw new Error('forced rollback');
    });
    const settled = transaction.catch((error: unknown) => error);
    await dropped.promise;

    // Statements are prepared against the schema as it is at that moment, so
    // preparing one before it passes the gate would fail with "no such table"
    // for a table whose DROP the transaction is about to roll back.
    const outside = Promise.allSettled([readIds(handle), handle.db.select().from(tTable)]);
    await pause();
    release.resolve();

    expect(await settled).toEqual(new Error('forced rollback'));
    expect(await outside).toEqual([
      { status: 'fulfilled', value: ['before'] },
      { status: 'fulfilled', value: [{ id: 'before' }] },
    ]);
  });

  it('runs nested transactions of one transaction one at a time', async () => {
    const handle = await openHandle();
    const events: string[] = [];

    await executeTransaction(handle.db, async (tx) => {
      // Both savepoints are requested before either finished. A savepoint
      // that opened while the other was open would end up inside it, and the
      // rollback of the first would take the second's name with it.
      const first = tx.transaction(async (nested) => {
        events.push('first:start');
        await nested.run(sql`INSERT INTO t (id) VALUES ('first')`);
        await pause(5);
        events.push('first:end');
        throw new Error('forced rollback of the first');
      });
      const second = tx.transaction(async (nested) => {
        events.push('second:start');
        await nested.run(sql`INSERT INTO t (id) VALUES ('second')`);
        events.push('second:end');
      });

      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'fulfilled']);
    });

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(await readIds(handle)).toEqual(['second']);
  });

  it('completes a statement queued behind a transaction before the next transaction starts', async () => {
    const handle = await openHandle();
    const inTransaction = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let seenByNext: Array<{ id: string }> = [];

    const first = executeTransaction(handle.db, async () => {
      inTransaction.resolve();
      await release.promise;
    });
    await inTransaction.promise;
    const statement = handle.raw.run(sql`INSERT INTO t (id) VALUES ('queued')`);
    // Drizzle needs a few turns to hand the statement to the driver, which is
    // where it queues at the gate; the transaction requested afterwards queues
    // behind it. The gate is only occupied for the statement's synchronous
    // start, which finishes the driver's work (see HandleGate#run).
    await pause();
    const next = executeTransaction(handle.db, async (tx) => {
      seenByNext = await tx.all<{ id: string }>(sql`SELECT id FROM t`);
    });
    release.resolve();
    await Promise.all([first, statement, next]);

    expect(seenByNext).toEqual([{ id: 'queued' }]);
  });

  it('serializes raw BEGIN sessions on the handle', async () => {
    const handle = await openHandle();
    const events: string[] = [];
    const firstInside = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();

    /**
     * Run one raw `BEGIN IMMEDIATE` transaction the way storage callers do.
     * @param id - Row the transaction inserts.
     * @param outcome - Whether the transaction commits or rolls back.
     * @param hold - Gate the transaction waits on after its insert.
     */
    const rawTransaction = async (id: string, outcome: 'COMMIT' | 'ROLLBACK', hold?: Promise<void>): Promise<void> => {
      await handle.raw.withSession(async (session) => {
        await session.run(sql.raw('BEGIN IMMEDIATE'));
        events.push(`${id}:begin`);
        await session.run(sql`INSERT INTO t (id) VALUES (${id})`);
        await hold;
        events.push(`${id}:end`);
        await session.run(sql.raw(outcome));
      });
    };

    const first = rawTransaction('first', 'ROLLBACK', Promise.all([firstInside.promise, releaseFirst.promise]).then());
    firstInside.resolve();
    const second = rawTransaction('second', 'COMMIT');
    const outside = handle.raw.run(sql`INSERT INTO t (id) VALUES ('outside')`).then(() => events.push('outside:done'));
    const nested = executeTransaction(handle.db, async (tx) => {
      events.push('transaction:begin');
      await tx.run(sql`INSERT INTO t (id) VALUES ('transaction')`);
    });
    await pause();
    // Only the first session ever started; everything else waits for it.
    expect(events).toEqual(['first:begin']);

    releaseFirst.resolve();
    await Promise.all([first, second, outside, nested]);

    // Whatever queued behind the first session runs only after it ended, and
    // the second session is never interleaved with another statement or
    // transaction (their relative order is not part of the contract).
    expect(events.slice(0, 2)).toEqual(['first:begin', 'first:end']);
    expect(events.indexOf('second:end')).toBe(events.indexOf('second:begin') + 1);
    expect([...events.slice(2)].sort()).toEqual(
      ['outside:done', 'second:begin', 'second:end', 'transaction:begin'].sort(),
    );
    // The first session's rollback took nothing of the others with it.
    expect(await readIds(handle)).toEqual(['outside', 'second', 'transaction']);
  });
});
