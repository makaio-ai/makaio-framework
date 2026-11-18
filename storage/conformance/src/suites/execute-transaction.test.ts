/**
 * Conformance suite: executeTransaction semantics.
 *
 * Covers:
 * 1. Multi-statement commit: both rows visible after the callback resolves.
 * 2. Rollback: a throwing callback propagates the rejection AND every partial
 *    write it awaited is absent (weak-net: queries the DB, not just trusts the
 *    rejection).
 * 3. Return value: the callback's resolved value is returned by executeTransaction.
 * 4. Concurrency: two overlapping executeTransaction calls (Promise.all), each
 *    inserting distinct rows with an in-callback await delay, both fulfil and
 *    all rows are present. The per-handle queue serializes them on every
 *    dialect — same assertions, no dialect branching.
 * 5. Post-rollback usability: after a rollback, a plain insert on ctx.db succeeds.
 * 6. Read-modify-write serialization: two concurrent clear-all-flags-then-
 *    set-own-flag callbacks both fulfil and leave exactly one row flagged —
 *    the invariant default-marker callers rely on.
 * 7. Nested transactions: a rejecting `tx.transaction()` rolls back every
 *    write it awaited and only those; a resolving one commits with the outer
 *    transaction.
 */
import { beforeAll, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { executeTransaction, resolveSchema } from '@makaio/storage-drizzle';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { fixtureKvDdl, fixtureKv } from '../harness/fixture-table.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simple async delay used inside transaction callbacks to force overlap.
 * @param ms - Milliseconds to wait.
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('execute-transaction', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });

  beforeAll(async () => {
    // Create the fixture table in this suite's isolated database/schema.
    // fixtureKvDdl emits CREATE TABLE IF NOT EXISTS, so repeated setup is idempotent.
    const ctx = getCtx();
    await ctx.executor.run(sql.raw(fixtureKvDdl(ctx.dialect)));
  });

  // ─── Case 1: multi-statement commit ──────────────────────────────────────

  it('commits both inserts when the callback resolves', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const id1 = `tx-commit-1-${Date.now()}`;
    const id2 = `tx-commit-2-${Date.now()}`;

    await executeTransaction(ctx.db, async (tx) => {
      await tx.insert(kv).values({ id: id1, label: 'commit-a', payload: { x: 1 } });
      await tx.insert(kv).values({ id: id2, label: 'commit-b', payload: { x: 2 } });
    });

    const row1 = await ctx.db.select().from(kv).where(eq(kv.id, id1));
    const row2 = await ctx.db.select().from(kv).where(eq(kv.id, id2));
    expect(row1).toHaveLength(1);
    expect(row2).toHaveLength(1);
  });

  // ─── Case 2: rollback ────────────────────────────────────────────────────

  it('propagates the rejection and the partial write is absent after a rollback', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const id1 = `tx-rollback-1-${Date.now()}`;
    const id2 = `tx-rollback-2-${Date.now()}`;

    // Two awaited statements: the rollback must cover everything the callback
    // wrote, not only the work done before its first await.
    await expect(
      executeTransaction(ctx.db, async (tx) => {
        await tx.insert(kv).values({ id: id1, label: 'rollback', payload: {} });
        await tx.insert(kv).values({ id: id2, label: 'rollback', payload: {} });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    // Weak-net: confirm the rows are absent — do not trust the rejection alone.
    const rows = await ctx.db
      .select()
      .from(kv)
      .where(inArray(kv.id, [id1, id2]));
    expect(rows).toHaveLength(0);
  });

  // ─── Case 3: return value ────────────────────────────────────────────────

  it('returns the value resolved by the callback', async () => {
    const result = await executeTransaction(getCtx().db, async () => {
      return { answer: 42 };
    });

    expect(result).toEqual({ answer: 42 });
  });

  // ─── Case 4: concurrency ─────────────────────────────────────────────────

  it('two overlapping executeTransaction calls both fulfil and all rows are present', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const id1 = `tx-concurrent-a-${Date.now()}`;
    const id2 = `tx-concurrent-b-${Date.now() + 1}`;

    // Both transactions start concurrently via Promise.all.
    // Each inserts one distinct row after a small await delay.
    // The per-handle queue serializes them one after the other on every
    // dialect; both must fulfil and all rows must be present.
    await Promise.all([
      executeTransaction(ctx.db, async (tx) => {
        await delay(10);
        await tx.insert(kv).values({ id: id1, label: 'concurrent-a', payload: { side: 'a' } });
      }),
      executeTransaction(ctx.db, async (tx) => {
        await delay(10);
        await tx.insert(kv).values({ id: id2, label: 'concurrent-b', payload: { side: 'b' } });
      }),
    ]);

    const rows1 = await ctx.db.select().from(kv).where(eq(kv.id, id1));
    const rows2 = await ctx.db.select().from(kv).where(eq(kv.id, id2));
    expect(rows1).toHaveLength(1);
    expect(rows2).toHaveLength(1);
  });

  // ─── Case 5: post-rollback usability ─────────────────────────────────────

  it('a plain insert on ctx.db succeeds after a rollback (handle not poisoned)', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const rollbackId = `tx-poison-check-rollback-${Date.now()}`;
    const afterId = `tx-poison-check-after-${Date.now()}`;

    // Trigger a rollback.
    await expect(
      executeTransaction(ctx.db, async (tx) => {
        await tx.insert(kv).values({ id: rollbackId, label: 'poison', payload: {} });
        throw new Error('deliberate rollback');
      }),
    ).rejects.toThrow('deliberate rollback');

    // The handle must remain fully functional.
    await ctx.db.insert(kv).values({ id: afterId, label: 'post-rollback', payload: { ok: true } });

    const rows = await ctx.db.select().from(kv).where(eq(kv.id, afterId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ ok: true });

    // Also confirm the rolled-back row is still absent.
    const absentRows = await ctx.db.select().from(kv).where(eq(kv.id, rollbackId));
    expect(absentRows).toHaveLength(0);
  });

  // ─── Case 6: read-modify-write serialization ─────────────────────────────

  it('two concurrent read-modify-write transactions leave exactly one row flagged', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const idA = `tx-rmw-a-${Date.now()}`;
    const idB = `tx-rmw-b-${Date.now() + 1}`;
    await ctx.db.insert(kv).values([
      { id: idA, label: 'rmw-unflagged', payload: {} },
      { id: idB, label: 'rmw-unflagged', payload: {} },
    ]);

    /**
     * Clear every flag, then flag the caller's own row — the read-modify-write
     * shape default-marker callers use (e.g. switching a default profile under
     * a partial unique index). The delay widens the clear→set window so an
     * unserialized run would interleave the two callbacks.
     * @param ownId - Row to flag after clearing all existing flags.
     */
    async function claimFlag(ownId: string): Promise<void> {
      await executeTransaction(ctx.db, async (tx) => {
        await tx.update(kv).set({ label: 'rmw-unflagged' }).where(eq(kv.label, 'rmw-flagged'));
        await delay(10);
        await tx.update(kv).set({ label: 'rmw-flagged' }).where(eq(kv.id, ownId));
      });
    }

    // Both must fulfil; the per-handle queue guarantees each callback observes
    // the other's committed state, so exactly one flag survives.
    await Promise.all([claimFlag(idA), claimFlag(idB)]);

    const flagged = await ctx.db.select().from(kv).where(eq(kv.label, 'rmw-flagged'));
    expect(flagged).toHaveLength(1);
    expect([idA, idB]).toContain(flagged[0]!.id);
  });

  // ─── Case 7: nested transactions ─────────────────────────────────────────

  it('a rejecting nested transaction rolls back only its own writes', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const suffix = Date.now();
    const outerId = `tx-nested-outer-${suffix}`;
    const keptIds = [`tx-nested-kept-1-${suffix}`, `tx-nested-kept-2-${suffix}`];
    const discardedIds = [`tx-nested-discarded-1-${suffix}`, `tx-nested-discarded-2-${suffix}`];
    const afterId = `tx-nested-after-${suffix}`;

    // Each nested callback awaits two statements: its savepoint must cover
    // the work after its first await, exactly like the outer transaction.
    await executeTransaction(ctx.db, async (tx) => {
      await tx.insert(kv).values({ id: outerId, label: 'nested-outer', payload: {} });
      await tx.transaction(async (nested) => {
        for (const id of keptIds) await nested.insert(kv).values({ id, label: 'nested-kept', payload: {} });
      });
      await expect(
        tx.transaction(async (nested) => {
          for (const id of discardedIds) await nested.insert(kv).values({ id, label: 'nested-discarded', payload: {} });
          throw new Error('forced nested rollback');
        }),
      ).rejects.toThrow('forced nested rollback');
      await tx.insert(kv).values({ id: afterId, label: 'nested-after', payload: {} });
    });

    const rows = await ctx.db
      .select({ id: kv.id })
      .from(kv)
      .where(inArray(kv.id, [outerId, ...keptIds, ...discardedIds, afterId]));
    expect(rows.map((row) => row.id).sort()).toEqual([outerId, ...keptIds, afterId].sort());
  });
});
