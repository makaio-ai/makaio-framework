import { JournalError } from '@makaio/contracts';
import { createHostDatabase, getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { journalStorageSchema } from '@makaio/services-core/journal/storage';
import { expect, it } from 'vitest';
import { moveEdgeCursor, readEdgeCursors } from '../../../../services/core/src/journal/storage/edge-cursors.js';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

describeStorageConformance('journal edge cursors', (config) => {
  const postgresSettings = { default_transaction_isolation: 'read committed' };
  const getCtx = useSuiteDatabaseContext(config, { postgresSettings });
  const edge = 'connector.inbound';

  /**
   * Read an edge's cursors through a host transaction.
   * @param partitions - Partitions to request.
   * @param name - Edge to read.
   * @returns The cursors in request order.
   */
  function read(partitions: readonly string[], name = edge): ReturnType<typeof readEdgeCursors> {
    return createHostDatabase(getCtx().db).transaction((tx) =>
      readEdgeCursors(getTransactionQueryContext(tx), name, partitions),
    );
  }

  /**
   * Attempt a cursor move through a host transaction.
   * @param input - Edge, partition and cursor values for the move.
   * @param db - Handle used by the contender.
   * @returns Completion of the transaction.
   */
  function move(input: Parameters<typeof moveEdgeCursor>[1], db = getCtx().db): Promise<void> {
    return createHostDatabase(db).transaction((tx) => moveEdgeCursor(getTransactionQueryContext(tx), input));
  }

  it('inserts a missing cursor and moves it from the matching value', async () => {
    const partition = 'first';
    await move({ edge, partition, from: null, to: 'initial' });
    expect(await read([partition])).toEqual([{ partition, value: 'initial' }]);

    await move({ edge, partition, from: 'initial', to: 'next' });
    expect(await read([partition])).toEqual([{ partition, value: 'next' }]);
  });

  it('updates an existing cursor whose value is null', async () => {
    const partition = 'stored-null';
    await createHostDatabase(getCtx().db).transaction(async (tx) => {
      const q = getTransactionQueryContext(tx);
      const { journalEdgeCursors } = resolveSchema(q, journalStorageSchema);
      await q.insert(journalEdgeCursors).values({ edge, partition, value: null });
    });
    expect(await read([partition])).toEqual([{ partition, value: null }]);

    await move({ edge, partition, from: null, to: 'next' });
    expect(await read([partition])).toEqual([{ partition, value: 'next' }]);
  });

  it.each([
    { partition: 'stale', from: 'older' },
    { partition: 'stale-first-delivery', from: null },
  ])('rejects a stale move for $partition and preserves the cursor', async ({ partition, from }) => {
    await move({ edge, partition, from: null, to: 'current' });
    const result = move({ edge, partition, from, to: 'overwritten' });

    await expect(result).rejects.toBeInstanceOf(JournalError);
    await expect(result).rejects.toMatchObject({ code: 'cursor-moved' });
    expect(await read([partition])).toEqual([{ partition, value: 'current' }]);
  });

  it('rejects a non-null expectation for a missing cursor', async () => {
    const partition = 'missing-for-update';
    await expect(move({ edge, partition, from: 'expected', to: 'next' })).rejects.toMatchObject({
      code: 'cursor-moved',
    });
    expect(await read([partition])).toEqual([{ partition, value: null }]);
  });

  it('scopes moves and reads to the edge and returns partitions in request order', async () => {
    const otherEdge = 'other.inbound';
    await move({ edge, partition: 'a', from: null, to: 'first' });
    await move({ edge: otherEdge, partition: 'a', from: null, to: 'first' });
    await move({ edge, partition: 'b', from: null, to: '' });
    await move({ edge, partition: 'a', from: 'first', to: 'advanced' });

    expect(await read(['b', 'missing', 'a', 'b'])).toEqual([
      { partition: 'b', value: '' },
      { partition: 'missing', value: null },
      { partition: 'a', value: 'advanced' },
      { partition: 'b', value: '' },
    ]);
    expect(await read(['a'], otherEdge)).toEqual([{ partition: 'a', value: 'first' }]);
    expect(await read([])).toEqual([]);
  });

  it('allows exactly one of two transactions to move from the same cursor', async () => {
    const ctx = getCtx();
    // SQLite queues the contenders on one handle. Two local connections can
    // block the event loop while waiting for the first transaction to commit.
    const rivalDb = config.dialect === 'postgres' ? (await ctx.createSiblingClient({ postgresSettings })).db : ctx.db;
    const partition = 'contended';
    await move({ edge, partition, from: null, to: 'initial' });
    const first = move({ edge, partition, from: 'initial', to: 'first' });
    const second = move({ edge, partition, from: 'initial', to: 'second' }, rivalDb);
    const outcomes = await Promise.allSettled([first, second]);

    expect(outcomes).toEqual(
      expect.arrayContaining([
        { status: 'fulfilled', value: undefined },
        { status: 'rejected', reason: expect.objectContaining({ code: 'cursor-moved' }) },
      ]),
    );
    expect(await read([partition])).toEqual([
      { partition, value: outcomes[0].status === 'fulfilled' ? 'first' : 'second' },
    ]);
  });
});
