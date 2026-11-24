import { randomUUID } from 'node:crypto';
import type { HostTransaction } from '@makaio/contracts/host-database';
import {
  createHostDatabase,
  getHostDatabaseWake,
  getHostTransactionQueryContext,
  getTransactionQueryContext,
  HostTransactionError,
  markTransactionRollbackOnly,
  markTransactionWakeTopic,
  resolveSchema,
} from '@makaio/storage-drizzle';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, expect, it } from 'vitest';
import { describeStorageConformance } from '../harness/env.js';
import { fixtureKv, fixtureKvDdl } from '../harness/fixture-table.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';

describeStorageConformance('host transaction authority', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });

  beforeAll(async () => {
    const ctx = getCtx();
    await ctx.executor.run(sql.raw(fixtureKvDdl(ctx.dialect)));
  });

  it('rejects a transaction minted by a facade over a different handle', async () => {
    const ctx = getCtx();
    const sibling = await ctx.createSiblingClient();
    const host = createHostDatabase(ctx.db);
    const otherHost = createHostDatabase(sibling.db);

    await host.transaction(async (tx) => {
      expect(getHostTransactionQueryContext(host, tx)).toBe(getTransactionQueryContext(tx));
      expect(() => getHostTransactionQueryContext(otherHost, tx)).toThrow(
        expect.objectContaining({ code: 'foreign-transaction' }),
      );
    });
  });

  it('rejects a transaction minted by a second facade over the same handle', async () => {
    const { db } = getCtx();
    const host = createHostDatabase(db);
    const otherHost = createHostDatabase(db);

    await host.transaction(async (tx) => {
      expect(() => getHostTransactionQueryContext(otherHost, tx)).toThrow(
        expect.objectContaining({ code: 'foreign-transaction' }),
      );
    });
  });

  it('rejects authorization and rollback marking after the transaction ends', async () => {
    const host = createHostDatabase(getCtx().db);
    const tx = await host.transaction(async (token) => token);
    const finished = expect.objectContaining({ code: 'transaction-finished' });

    expect(() => getHostTransactionQueryContext(host, tx)).toThrow(finished);
    expect(() => markTransactionRollbackOnly(tx, new Error('late rollback'))).toThrow(finished);
  });

  it('rejects rollback marking for a value that was never minted', () => {
    const foreign = Object.freeze({}) as HostTransaction;
    /** Try to mark an unminted transaction for rollback. */
    const mark = (): void => markTransactionRollbackOnly(foreign, new Error('foreign rollback'));

    expect(mark).toThrow(HostTransactionError);
    expect(mark).toThrow(expect.objectContaining({ code: 'foreign-transaction' }));
  });

  it('rolls back a domain write and suppresses its wake when a marked callback fulfils', async () => {
    const { db } = getCtx();
    const { kv } = resolveSchema(db, fixtureKv);
    const host = createHostDatabase(db);
    const wake = getHostDatabaseWake(host);
    const id = randomUUID();
    const cause = new Error('domain transaction must roll back');
    let wakes = 0;
    const unsubscribe = wake.subscribe(id, () => {
      wakes++;
    });

    try {
      await wake.ready();
      const result = host.transaction(async (tx) => {
        await getHostTransactionQueryContext(host, tx).insert(kv).values({ id });
        markTransactionWakeTopic(tx, id);
        markTransactionRollbackOnly(tx, cause);
        markTransactionRollbackOnly(tx, new Error('later failure'));
      });

      await expect(result).rejects.toBe(cause);
      expect(await db.select().from(kv).where(eq(kv.id, id))).toEqual([]);
      expect(wakes).toBe(0);
    } finally {
      unsubscribe();
    }
  });

  it('preserves the rejection of a callback that marked its transaction rollback-only', async () => {
    const host = createHostDatabase(getCtx().db);
    const rejection = new Error('callback rejected');

    await expect(
      host.transaction(async (tx) => {
        markTransactionRollbackOnly(tx, new Error('rollback cause'));
        throw rejection;
      }),
    ).rejects.toBe(rejection);
  });
});
