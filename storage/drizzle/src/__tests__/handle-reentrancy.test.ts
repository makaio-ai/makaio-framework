/**
 * Re-entrancy of SQLite handles.
 *
 * Work that asks for the handle (or for the operation queue) from inside the
 * callback that holds it would wait for itself. Both queues reject it with a
 * `ReentrantOperationError` before waiting, on every supported runtime/driver
 * (libsql under Node.js, `bun:sqlite` under Bun).
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { executeTransaction, serializeDatabaseOperation } from '../transaction';
import { pause, useHandleFixture } from './handle-fixture';

/** What every re-entrant call must be rejected with, instead of waiting for itself. */
const REENTRANT = { name: 'ReentrantOperationError', message: expect.stringMatching(/re-entrant/i) };

describe('SQLite handle re-entrancy', () => {
  const { openHandle, readIds } = useHandleFixture('handle-reentrancy');

  it('rejects a transaction opened from inside a transaction callback', async () => {
    const handle = await openHandle();

    await expect(
      executeTransaction(handle.db, async () => {
        await executeTransaction(handle.db, async () => undefined);
      }),
    ).rejects.toMatchObject(REENTRANT);
    // The rejected nested call must not have wedged the handle.
    await executeTransaction(handle.db, async (tx) => {
      await tx.run(sql`INSERT INTO t (id) VALUES ('after')`);
    });
    expect(await readIds(handle)).toEqual(['after']);
  });

  it('rejects a serialized operation started from inside a transaction callback', async () => {
    const handle = await openHandle();

    await expect(
      executeTransaction(handle.db, async () => {
        await serializeDatabaseOperation(handle.db, async () => undefined);
      }),
    ).rejects.toMatchObject(REENTRANT);
  });

  it('rejects a transaction or operation started from inside a raw session', async () => {
    const handle = await openHandle();

    await expect(
      handle.raw.withSession(async () => {
        await executeTransaction(handle.db, async () => undefined);
      }),
    ).rejects.toMatchObject(REENTRANT);
    await expect(
      handle.raw.withSession(async () => {
        await serializeDatabaseOperation(handle.db, async () => undefined);
      }),
    ).rejects.toMatchObject(REENTRANT);
  });

  it('rejects a raw session opened from inside a raw session or a transaction callback', async () => {
    const handle = await openHandle();

    await expect(
      handle.raw.withSession(async () => {
        await handle.raw.withSession(async () => undefined);
      }),
    ).rejects.toMatchObject(REENTRANT);
    await expect(
      executeTransaction(handle.db, async () => {
        await handle.raw.withSession(async () => undefined);
      }),
    ).rejects.toMatchObject(REENTRANT);
  });

  it('rejects an operation a raw session requests while a transaction queued for the handle', async () => {
    const handle = await openHandle();
    const sessionOpen = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    let transactionRan = false;

    const session = handle.raw
      .withSession(async () => {
        sessionOpen.resolve();
        await proceed.promise;
        await serializeDatabaseOperation(handle.db, async () => undefined);
      })
      .catch((error: unknown) => error);
    await sessionOpen.promise;
    // The transaction takes the operation queue and then waits for the handle
    // the session holds; the session asking the queue for its next operation
    // would complete the cycle.
    const transaction = executeTransaction(handle.db, async () => {
      transactionRan = true;
    });
    await pause();
    expect(transactionRan).toBe(false);
    proceed.resolve();

    expect(await session).toMatchObject(REENTRANT);
    await transaction;
    expect(transactionRan).toBe(true);
  });

  it('keeps plain statements of the holder working and releases a context once its work ended', async () => {
    const handle = await openHandle();
    let late: Promise<void> | undefined;

    await executeTransaction(handle.db, async (tx) => {
      // A read on the handle itself is never held back (writes belong on `tx`).
      expect(await handle.raw.all(sql`SELECT 1 AS one`)).toEqual([{ one: 1 }]);
      await tx.run(sql`INSERT INTO t (id) VALUES ('tx')`);
      // Timers keep the async context of the callback alive after it ended.
      setTimeout(() => {
        late = executeTransaction(handle.db, async (lateTx) => {
          await lateTx.run(sql`INSERT INTO t (id) VALUES ('late')`);
        });
      }, 5);
    });
    await pause(25);
    await late;

    expect(await readIds(handle)).toEqual(['late', 'tx']);
  });
});
