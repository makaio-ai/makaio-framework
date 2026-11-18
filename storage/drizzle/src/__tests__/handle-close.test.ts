/**
 * Close contract of SQLite handles.
 *
 * `close()` goes through the handle's gate like any other statement: it waits
 * for the transaction or raw session that holds the handle and for everything
 * that queued for the handle before it, then closes the connection. Runs on
 * every supported runtime/driver (libsql under Node.js, `bun:sqlite` under Bun).
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabaseClient } from '../client';
import { getRawSqlExecutor } from '../raw-sql';
import { executeTransaction } from '../transaction';
import { pause, useHandleFixture, type Handle } from './handle-fixture';

describe('SQLite handle close', () => {
  const { openHandle } = useHandleFixture('handle-close');

  /**
   * Read the committed ids of a handle's file through a second, independent handle.
   * @param handle - Handle whose database file is read.
   * @returns Committed ids in ascending order.
   */
  async function readCommittedIds(handle: Handle): Promise<string[]> {
    const reader = await createDatabaseClient({ url: `file:${handle.databaseFile}` });
    try {
      const rows = await getRawSqlExecutor(reader.db).all<{ id: string }>(sql`SELECT id FROM t ORDER BY id`);
      return rows.map((row) => row.id);
    } finally {
      await reader.close();
    }
  }

  it('waits for an open transaction and for what queued before it, then closes', async () => {
    const handle = await openHandle();
    const inTransaction = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closed = false;

    const transaction = executeTransaction(handle.db, async (tx) => {
      await tx.run(sql`INSERT INTO t (id) VALUES ('first')`);
      inTransaction.resolve();
      await release.promise;
      await tx.run(sql`INSERT INTO t (id) VALUES ('second')`);
    });
    await inTransaction.promise;
    const queued = handle.raw.run(sql`INSERT INTO t (id) VALUES ('queued')`);
    // Drizzle needs a few turns to hand the statement to the driver, which is
    // where it queues at the gate: the contract covers what queued before.
    await pause();
    const closing = Promise.resolve(handle.client.close()).then(() => {
      closed = true;
    });
    await pause();

    // The transaction is neither cut off nor torn away from its connection.
    expect(closed).toBe(false);
    release.resolve();
    await transaction;
    await queued;
    await closing;
    expect(closed).toBe(true);
    expect(await readCommittedIds(handle)).toEqual(['first', 'queued', 'second']);
  });

  it('waits for an open raw session', async () => {
    const handle = await openHandle();
    const inSession = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let closed = false;

    const session = handle.raw.withSession(async (pinned) => {
      await pinned.run(sql.raw('BEGIN IMMEDIATE'));
      await pinned.run(sql`INSERT INTO t (id) VALUES ('raw')`);
      inSession.resolve();
      await release.promise;
      await pinned.run(sql.raw('COMMIT'));
    });
    await inSession.promise;
    const closing = Promise.resolve(handle.client.close()).then(() => {
      closed = true;
    });
    await pause();

    expect(closed).toBe(false);
    release.resolve();
    await session;
    await closing;
    expect(await readCommittedIds(handle)).toEqual(['raw']);
  });

  it('fails statements that start after the close was requested', async () => {
    const handle = await openHandle();
    await handle.client.close();

    await expect(handle.raw.run(sql`INSERT INTO t (id) VALUES ('late')`)).rejects.toThrow();
    expect(await readCommittedIds(handle)).toEqual([]);
  });

  it('is idempotent and returns the first call result on repeated calls', async () => {
    const handle = await openHandle();
    const release = Promise.withResolvers<void>();
    const inTransaction = Promise.withResolvers<void>();
    const transaction = executeTransaction(handle.db, async () => {
      inTransaction.resolve();
      await release.promise;
    });
    await inTransaction.promise;

    const first = handle.client.close();
    const second = handle.client.close();
    expect(second).toBe(first);
    release.resolve();
    await transaction;
    await first;
    await expect(Promise.resolve(handle.client.close())).resolves.toBeUndefined();
  });

  it('rejects a holder that awaits close() even while an outside close is already pending', async () => {
    const handle = await openHandle();
    const inTransaction = Promise.withResolvers<void>();
    const outsideClosePending = Promise.withResolvers<void>();

    const transaction = executeTransaction(handle.db, async () => {
      inTransaction.resolve();
      await outsideClosePending.promise;
      // The outside close is cached and waits for this very transaction:
      // handing its promise to the holder would make both wait for each other.
      await handle.client.close();
    });
    const outcome = transaction.catch((error: unknown) => error);
    await inTransaction.promise;
    const closing = handle.client.close();
    outsideClosePending.resolve();

    expect(await outcome).toMatchObject({ name: 'ReentrantOperationError' });
    await closing;
  });

  it('rejects a close requested from inside the transaction that holds the handle', async () => {
    const handle = await openHandle();

    await expect(
      executeTransaction(handle.db, async (tx) => {
        await tx.run(sql`INSERT INTO t (id) VALUES ('inside')`);
        await handle.client.close();
      }),
    ).rejects.toMatchObject({ name: 'ReentrantOperationError' });

    // The rejected close left the handle open and the transaction rolled back.
    await handle.raw.run(sql`INSERT INTO t (id) VALUES ('after')`);
    await handle.client.close();
    expect(await readCommittedIds(handle)).toEqual(['after']);
  });
});
