/**
 * Conformance suite: the host transaction facade (`createHostDatabase`,
 * `getTransactionQueryContext`).
 *
 * Guarantee under test: every execution of a builder or prepared query created
 * through the context of a host transaction runs in exactly that transaction.
 * Once the transaction ended, execution fails with `HostTransactionError`
 * (`transaction-finished`) BEFORE any database access: never in autocommit,
 * never in another transaction. A value the facade did not mint is rejected
 * with `foreign-transaction`.
 *
 * Every negative case whose rejection could possibly follow database access
 * also re-reads the stored rows through the plain handle (weak-net: the
 * database is the evidence, not the rejection alone). The foreign-transaction
 * case is the one exception: its rejection comes from a registry lookup that
 * never reaches the database, so there is no row to re-read.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  createHostDatabase,
  executeTransaction,
  getTransactionQueryContext,
  HostTransactionError,
  resolveSchema,
  type MakaioDatabase,
  type StorageDialect,
  type TransactionQueryContext,
} from '@makaio/storage-drizzle';
import type { HostTransaction } from '@makaio/contracts/host-database';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { fixtureKvDdl, fixtureKv, type conformanceKvSqlite } from '../harness/fixture-table.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical (SQLite view) fixture table type the builders are created from. */
type KvTable = typeof conformanceKvSqlite;

/** Error code carried by a {@link HostTransactionError}. */
type HostTransactionErrorCode = HostTransactionError['code'];

/** A one-shot latch: `opened` settles once `open()` was called. */
interface Gate {
  /** Resolves after {@link Gate.open}. */
  readonly opened: Promise<void>;
  /** Open the gate. Idempotent. */
  open(): void;
}

/**
 * Create a closed gate.
 * @returns A gate whose `opened` promise resolves after `open()`.
 */
function createGate(): Gate {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open() };
}

/** A promise whose settlement is controlled from outside. */
interface Deferred<T> {
  /** Settles after {@link Deferred.resolve}. */
  readonly promise: Promise<T>;
  /**
   * Fulfil the promise.
   * @param value - Value to fulfil with.
   */
  resolve(value: T): void;
}

/**
 * Create a pending deferred value.
 * @typeParam T - Type of the value.
 * @returns A deferred whose promise fulfils after `resolve(value)`.
 */
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value) => resolve(value) };
}

/**
 * Wait for the given time, letting pending macrotasks run.
 * @param ms - Milliseconds to wait.
 */
async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Unique row id per case so cases never see each other's rows.
 * @param prefix - Human-readable case prefix.
 * @returns A unique id.
 */
function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/**
 * Read the stored rows with the given ids through a plain handle, ordered by id.
 * @param db - Handle to read through (the suite handle or a fresh sibling).
 * @param ids - Row ids to read.
 * @returns The rows that exist, ordered by id.
 */
async function readRows(db: MakaioDatabase, ids: readonly string[]) {
  const { kv } = resolveSchema(db, fixtureKv);
  return db
    .select()
    .from(kv)
    .where(inArray(kv.id, [...ids]))
    .orderBy(kv.id);
}

/**
 * Assert that a thrown value is a {@link HostTransactionError} with the given code.
 * @param error - The caught value.
 * @param code - Expected machine-readable code.
 */
function expectHostTransactionError(error: unknown, code: HostTransactionErrorCode): void {
  expect(error).toBeInstanceOf(HostTransactionError);
  expect(error).toMatchObject({ code });
}

/**
 * Run an operation (synchronous throw, rejected promise or awaited thenable)
 * and assert that it fails with a {@link HostTransactionError} of the given code.
 * @param run - Operation to execute; its result is awaited.
 * @param code - Expected machine-readable code.
 */
async function expectFailsWith(run: () => unknown, code: HostTransactionErrorCode): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expectHostTransactionError(caught, code);
}

/**
 * Prepare a query created through a transaction context.
 *
 * node-postgres requires a statement name for `prepare(name)`; SQLite takes
 * none. The context exposes the canonical SQLite view of the builders, whose
 * `prepare()` is assignable to `prepare(name?: string)`, so the dialect branch
 * needs no cast: the name is only supplied on Postgres.
 * @typeParam P - Prepared query type of the builder.
 * @param builder - Builder to prepare.
 * @param dialect - Dialect of the handle.
 * @returns The prepared query.
 */
function prepareQuery<P>(builder: { prepare(name?: string): P }, dialect: StorageDialect): P {
  return builder.prepare(dialect === 'postgres' ? `hostdb_${randomUUID().replaceAll('-', '')}` : undefined);
}

/**
 * Create one unexecuted builder of every kind through the context.
 * @param context - Query context of the transaction.
 * @param kv - Fixture table.
 * @param insertId - Id the insert would write.
 * @param targetId - Id the update/delete/select address (a seeded row).
 * @returns The four builders, not awaited.
 */
function createBuilders(context: TransactionQueryContext, kv: KvTable, insertId: string, targetId: string) {
  return {
    insert: context.insert(kv).values({ id: insertId, label: 'escaped-insert', payload: {} }),
    update: context.update(kv).set({ label: 'escaped-update' }).where(eq(kv.id, targetId)),
    delete: context.delete(kv).where(eq(kv.id, targetId)),
    select: context.select().from(kv).where(eq(kv.id, targetId)),
  };
}

/**
 * Prepare one query of every kind through the context.
 * @param context - Query context of the transaction.
 * @param kv - Fixture table.
 * @param dialect - Dialect of the handle.
 * @param insertId - Id the insert would write.
 * @param targetId - Id the update/delete/select address (a seeded row).
 * @returns The four prepared queries.
 */
function createPrepared(
  context: TransactionQueryContext,
  kv: KvTable,
  dialect: StorageDialect,
  insertId: string,
  targetId: string,
) {
  const builders = createBuilders(context, kv, insertId, targetId);
  return {
    insert: prepareQuery(builders.insert, dialect),
    update: prepareQuery(builders.update, dialect),
    delete: prepareQuery(builders.delete, dialect),
    select: prepareQuery(builders.select, dialect),
  };
}

/** The four prepared queries of {@link createPrepared}. */
type PreparedSet = ReturnType<typeof createPrepared>;

/**
 * Terminal methods of the prepared insert, per dialect.
 *
 * SQLite offers `run`, `all`, `get`, `values` and `execute`; node-postgres
 * offers `execute` and `all` (both reach `client.query` on their own). The
 * prepared type is the canonical SQLite view, so the Postgres branch simply
 * never touches the SQLite-only `run`, `get` and `values`.
 * @param prepared - Prepared insert query.
 * @param dialect - Dialect of the handle.
 * @returns Terminal name to invocation.
 */
function terminalsOf(prepared: PreparedSet['insert'], dialect: StorageDialect): Record<string, () => unknown> {
  if (dialect === 'postgres') {
    return { execute: () => prepared.execute(), all: () => prepared.all() };
  }
  return {
    run: () => prepared.run(),
    all: () => prepared.all(),
    get: () => prepared.get(),
    values: () => prepared.values(),
    execute: () => prepared.execute(),
  };
}

/**
 * Execute every prepared query of the set (the insert through each terminal)
 * and assert each fails with `transaction-finished`.
 * @param prepared - Stale prepared queries.
 * @param dialect - Dialect of the handle.
 */
async function expectPreparedFinished(prepared: PreparedSet, dialect: StorageDialect): Promise<void> {
  for (const run of Object.values(terminalsOf(prepared.insert, dialect))) {
    await expectFailsWith(run, 'transaction-finished');
  }
  await expectFailsWith(() => prepared.update.execute(), 'transaction-finished');
  await expectFailsWith(() => prepared.delete.execute(), 'transaction-finished');
  await expectFailsWith(() => prepared.select.execute(), 'transaction-finished');
}

/**
 * Settlement of {@link expectRejectsThroughCatch}'s internal `.then()`.
 */
type Settlement = { readonly status: 'fulfilled' } | { readonly status: 'rejected'; readonly error: unknown };

/**
 * Run an operation and assert that it rejects with a {@link HostTransactionError}
 * of the given code, observed ONLY through `.then(undefined, onRejected)`.
 *
 * Unlike {@link expectFailsWith}, `run()` is never wrapped in a `try` block: a
 * synchronous throw from it is not caught here, so it escapes this helper as
 * an uncaught failure instead of being silently treated the same as a promise
 * rejection — the exact distinction a `.catch()` chain in real code depends on,
 * and that an `await` inside a `try` cannot tell apart. `run()` is evaluated as
 * a plain argument expression to `Promise.resolve`, so a synchronous throw
 * propagates before `Promise.resolve` is ever reached — `.then()` only ever
 * observes a value `run()` actually returned.
 * @param run - Operation whose settlement is observed.
 * @param code - Expected machine-readable code.
 */
async function expectRejectsThroughCatch(run: () => unknown, code: HostTransactionErrorCode): Promise<void> {
  const settled: Settlement = await Promise.resolve(run()).then(
    () => ({ status: 'fulfilled' }),
    (error: unknown) => ({ status: 'rejected', error }),
  );
  expect(settled.status).toBe('rejected');
  if (settled.status === 'rejected') {
    expectHostTransactionError(settled.error, code);
  }
}

/**
 * Assert that `run` throws the host transaction error synchronously, without
 * returning anything (the bun:sqlite delivery of a finished transaction).
 * @param run - Execution expected to throw before it returns.
 * @param code - Expected error code.
 */
function expectThrowsSynchronously(run: () => unknown, code: HostTransactionErrorCode): void {
  let caught: unknown;
  let returned: unknown;
  try {
    returned = run();
  } catch (error) {
    caught = error;
  }
  if (returned instanceof Promise) returned.catch(() => undefined);
  expect(returned).toBeUndefined();
  expectHostTransactionError(caught, code);
}

/**
 * Collect the messages of an error and its `cause` chain.
 * @param error - Caught value.
 * @returns Joined messages.
 */
function messageChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(' | ');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('host-database', (config) => {
  const getCtx = useSuiteDatabaseContext(config, { applyCentralChain: false });

  beforeAll(async () => {
    // fixtureKvDdl emits CREATE TABLE IF NOT EXISTS, so repeated setup is idempotent.
    const ctx = getCtx();
    await ctx.executor.run(sql.raw(fixtureKvDdl(ctx.dialect)));
  });

  // ─── Case 1: surface ─────────────────────────────────────────────────────

  it('exposes exactly dialect, select, insert, update and delete', async () => {
    const ctx = getCtx();
    const hostDb = createHostDatabase(ctx.db);

    const context = await hostDb.transaction(async (tx) => getTransactionQueryContext(tx));

    expect(Object.keys(context).sort()).toEqual(['delete', 'dialect', 'insert', 'select', 'update']);
    expect(context.dialect).toBe(ctx.dialect);
    expect(Object.isFrozen(context)).toBe(true);
  });

  // ─── Case 2: foreign transaction ─────────────────────────────────────────

  it('rejects a foreign transaction', async () => {
    // There is exactly one registry, so the transaction of another HostDatabase
    // is NOT foreign. A foreign value is any object the facade never minted: a
    // frozen empty object. The brand is a phantom `unique symbol` property, so
    // this single assertion (`{}` is a supertype of HostTransaction) is the
    // narrowest the type system allows; no double cast is needed.
    const foreign = Object.freeze({}) as HostTransaction;

    // getTransactionQueryContext never touches the database for a foreign
    // value (the rejection happens on the registry lookup alone), so there is
    // no row to seed or re-read: the rejection assertion is the whole case.
    await expectFailsWith(() => getTransactionQueryContext(foreign), 'foreign-transaction');
  });

  // ─── Case 3: entry points after the end ──────────────────────────────────

  it('rejects a new entry point after the transaction ended', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const seedId = uniqueId('host-entry-seed');
    const lateId = uniqueId('host-entry-late');
    await ctx.db.insert(kv).values({ id: seedId, label: 'seed', payload: {} });
    const before = await readRows(ctx.db, [seedId, lateId]);

    const kept = await hostDb.transaction(async (tx) => ({ tx, context: getTransactionQueryContext(tx) }));

    await expectFailsWith(() => getTransactionQueryContext(kept.tx), 'transaction-finished');
    await expectFailsWith(
      () => kept.context.insert(kv).values({ id: lateId, label: 'late', payload: {} }),
      'transaction-finished',
    );

    expect(await readRows(ctx.db, [seedId, lateId])).toEqual(before);
  });

  // ─── Case 4: escaped builders ────────────────────────────────────────────

  it('rejects an escaped builder awaited after the transaction ended', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const targetId = uniqueId('host-escape-target');
    const insertId = uniqueId('host-escape-insert');
    await ctx.db.insert(kv).values({ id: targetId, label: 'seed', payload: {} });
    const before = await readRows(ctx.db, [targetId, insertId]);

    // A builder is a thenable: returning it directly would make the callback's
    // promise adopt (execute) it. Wrapping it in an object keeps it unexecuted.
    const escaped = await hostDb.transaction(async (tx) => ({
      builders: createBuilders(getTransactionQueryContext(tx), kv, insertId, targetId),
    }));

    await expectFailsWith(() => escaped.builders.insert, 'transaction-finished');
    await expectFailsWith(() => escaped.builders.update, 'transaction-finished');
    await expectFailsWith(() => escaped.builders.delete, 'transaction-finished');
    await expectFailsWith(() => escaped.builders.select, 'transaction-finished');

    expect(await readRows(ctx.db, [targetId, insertId])).toEqual(before);
  });

  it('rejects an escaped builder awaited after the transaction rolled back', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const targetId = uniqueId('host-escape-rb-target');
    const insertId = uniqueId('host-escape-rb-insert');
    await ctx.db.insert(kv).values({ id: targetId, label: 'seed', payload: {} });
    const before = await readRows(ctx.db, [targetId, insertId]);

    let escaped: ReturnType<typeof createBuilders> | undefined;
    await expect(
      hostDb.transaction(async (tx) => {
        escaped = createBuilders(getTransactionQueryContext(tx), kv, insertId, targetId);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    expect(escaped).toBeDefined();
    await expectFailsWith(() => escaped?.insert, 'transaction-finished');
    await expectFailsWith(() => escaped?.update, 'transaction-finished');
    await expectFailsWith(() => escaped?.delete, 'transaction-finished');
    await expectFailsWith(() => escaped?.select, 'transaction-finished');

    expect(await readRows(ctx.db, [targetId, insertId])).toEqual(before);
  });

  // ─── Case 5: prepared queries after the end ──────────────────────────────

  it('rejects a prepared query executed after the transaction ended', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const targetId = uniqueId('host-prepared-target');
    const insertId = uniqueId('host-prepared-insert');
    await ctx.db.insert(kv).values({ id: targetId, label: 'seed', payload: {} });
    const before = await readRows(ctx.db, [targetId, insertId]);

    const stale = await hostDb.transaction(async (tx) => ({
      prepared: createPrepared(getTransactionQueryContext(tx), kv, ctx.dialect, insertId, targetId),
    }));

    await expectPreparedFinished(stale.prepared, ctx.dialect);

    expect(await readRows(ctx.db, [targetId, insertId])).toEqual(before);
  });

  it('rejects a stale prepared query executed while another transaction is open', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const targetId = uniqueId('host-prepared-open-target');
    const staleInsertId = uniqueId('host-prepared-open-stale');
    const secondId = uniqueId('host-prepared-open-second');
    await ctx.db.insert(kv).values({ id: targetId, label: 'seed', payload: {} });
    const seedRows = await readRows(ctx.db, [targetId]);

    const stale = await hostDb.transaction(async (tx) => ({
      prepared: createPrepared(getTransactionQueryContext(tx), kv, ctx.dialect, staleInsertId, targetId),
    }));

    // Second transaction on the same handle, held open until the stale
    // statements ran from outside its callback.
    const entered = createGate();
    const finish = createGate();
    const second = hostDb.transaction(async (tx) => {
      entered.open();
      await finish.opened;
      await getTransactionQueryContext(tx).insert(kv).values({ id: secondId, label: 'second', payload: {} });
    });

    try {
      await entered.opened;
      await expectPreparedFinished(stale.prepared, ctx.dialect);
    } finally {
      finish.open();
      await second;
    }

    // Both transactions ended: the stale write is absent, the second one is committed.
    const rows = await readRows(ctx.db, [targetId, staleInsertId, secondId]);
    expect(rows.map((row) => row.id).sort()).toEqual([targetId, secondId].sort());
    expect(rows.filter((row) => row.id === targetId)).toEqual(seedRows);
  });

  it('rejects an execution that was issued during the transaction but reaches the driver after it ended', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const id = uniqueId('host-driver-boundary');

    // The execution is issued from the OUTER async context: the continuation
    // after `await` keeps the context of the place the function was started
    // in, i.e. it runs outside the transaction's async context. It is started
    // before the transaction and settled into a result right away, so a
    // rejection is never unhandled.
    const handedOver = deferred<{ readonly run: () => unknown }>();
    const outside = (async () => (await handedOver.promise).run())().then(
      () => ({ status: 'fulfilled' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await hostDb.transaction(async (tx) => {
      const prepared = prepareQuery(
        getTransactionQueryContext(tx).insert(kv).values({ id, label: 'driver-boundary', payload: {} }),
        ctx.dialect,
      );
      const terminals = terminalsOf(prepared, ctx.dialect);
      const run = terminals.run ?? terminals.execute;
      handedOver.resolve({ run: () => run?.() });
      // Let the outside continuation issue the call (a promise microtask). Do NOT await
      // `outside`: on bun:sqlite the statement waits at the handle gate until
      // this transaction settled, so awaiting it here would deadlock.
      await delay(50);
    });

    const result = await outside;
    const inTransaction = await readRows(ctx.db, [id]);
    const fresh = config.dialect === 'sqlite' ? await ctx.createSiblingClient() : undefined;
    const viaSibling = fresh === undefined ? inTransaction : await readRows(fresh.db, [id]);

    // Invariant: either refused after the end with the row absent, or it ran
    // inside the still-open transaction and committed with it. Never a
    // fulfilled execution without the row, nor a refusal with the row present.
    if (result.status === 'rejected') {
      expectHostTransactionError(result.error, 'transaction-finished');
      expect(inTransaction).toHaveLength(0);
      expect(viaSibling).toHaveLength(0);
    } else {
      expect(inTransaction).toHaveLength(1);
      expect(viaSibling).toHaveLength(1);
    }

    // This case pins the executor guard (`guardExecutor`): on bun:sqlite the
    // outside statement waits at the handle gate and passes the terminal-method
    // check before the transaction ended, so only the driver-boundary check can
    // refuse it.
    if ('Bun' in globalThis && config.dialect === 'sqlite') {
      expect(result.status).toBe('rejected');
    }
  });

  // ─── Case 5b: async-driver rejection delivery (not a synchronous throw) ──

  // bun:sqlite's executors settle synchronously, so a finished transaction is
  // expected to throw synchronously there (see `transaction-query-session.ts`);
  // these two cases pin the two async drivers (libsql, node-postgres) only.
  it.skipIf('Bun' in globalThis && config.dialect === 'sqlite')(
    'rejects an escaped builder terminal through catch, not a synchronous throw',
    async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const targetId = uniqueId('host-async-escape-target');
      const insertId = uniqueId('host-async-escape-insert');
      await ctx.db.insert(kv).values({ id: targetId, label: 'seed', payload: {} });
      const before = await readRows(ctx.db, [targetId, insertId]);

      const escaped = await hostDb.transaction(async (tx) => ({
        builders: createBuilders(getTransactionQueryContext(tx), kv, insertId, targetId),
      }));

      // `run` (SQLite/libsql) and `execute` (node-postgres) are plain bound
      // methods of the builder itself, not the thenable `execute()` that
      // `await`ing the builder goes through: they call into the guarded
      // session on every direct call, which is the path this case pins.
      await expectRejectsThroughCatch(
        () => (ctx.dialect === 'postgres' ? escaped.builders.insert.execute() : escaped.builders.insert.run()),
        'transaction-finished',
      );

      expect(await readRows(ctx.db, [targetId, insertId])).toEqual(before);
    },
  );

  it.skipIf('Bun' in globalThis && config.dialect === 'sqlite')(
    'rejects a prepared-query terminal through catch, not a synchronous throw',
    async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const targetId = uniqueId('host-async-prepared-target');
      const insertId = uniqueId('host-async-prepared-insert');
      await ctx.db.insert(kv).values({ id: targetId, label: 'seed', payload: {} });
      const before = await readRows(ctx.db, [targetId, insertId]);

      const stale = await hostDb.transaction(async (tx) => ({
        prepared: createPrepared(getTransactionQueryContext(tx), kv, ctx.dialect, insertId, targetId),
      }));

      await expectRejectsThroughCatch(() => stale.prepared.insert.execute(), 'transaction-finished');

      expect(await readRows(ctx.db, [targetId, insertId])).toEqual(before);
    },
  );

  it.skipIf(!('Bun' in globalThis && config.dialect === 'sqlite'))(
    'throws synchronously from an escaped builder and a stale prepared query on bun:sqlite',
    async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const targetId = uniqueId('host-sync-target');
      const insertId = uniqueId('host-sync-insert');
      await ctx.db.insert(kv).values({ id: targetId, label: 'seed', payload: {} });
      const before = await readRows(ctx.db, [targetId, insertId]);

      const stale = await hostDb.transaction(async (tx) => {
        const context = getTransactionQueryContext(tx);
        return {
          builders: createBuilders(context, kv, insertId, targetId),
          prepared: createPrepared(context, kv, ctx.dialect, insertId, targetId),
        };
      });

      expectThrowsSynchronously(() => stale.builders.insert.run(), 'transaction-finished');
      expectThrowsSynchronously(() => stale.prepared.insert.execute(), 'transaction-finished');

      expect(await readRows(ctx.db, [targetId, insertId])).toEqual(before);
    },
  );

  // ─── Case 6: prepared query inside ───────────────────────────────────────

  it('runs a prepared query inside the transaction', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const id = uniqueId('host-prepared-inside');

    await hostDb.transaction(async (tx) => {
      const prepared = prepareQuery(
        getTransactionQueryContext(tx)
          .insert(kv)
          .values({ id, label: 'prepared-inside', payload: { ok: true } }),
        ctx.dialect,
      );
      await prepared.execute();
    });

    const rows = await readRows(ctx.db, [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ ok: true });
  });

  // ─── Case 7: returning ───────────────────────────────────────────────────

  it('returns no rows from returning when the condition lost', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const lostId = uniqueId('host-returning-lost');
    const wonId = uniqueId('host-returning-won');
    await ctx.db.insert(kv).values([
      { id: lostId, label: 'actual', payload: {} },
      { id: wonId, label: 'expected', payload: {} },
    ]);

    const result = await hostDb.transaction(async (tx) => {
      const context = getTransactionQueryContext(tx);
      const lost = await context
        .update(kv)
        .set({ label: 'claimed' })
        .where(and(eq(kv.id, lostId), eq(kv.label, 'expected')))
        .returning();
      const won = await context
        .update(kv)
        .set({ label: 'claimed' })
        .where(and(eq(kv.id, wonId), eq(kv.label, 'expected')))
        .returning();
      return { lost, won };
    });

    expect(result.lost).toEqual([]);
    expect(result.won).toHaveLength(1);
    expect(result.won[0]).toMatchObject({ id: wonId, label: 'claimed' });

    const rows = await readRows(ctx.db, [lostId, wonId]);
    expect(rows.map((row) => [row.id, row.label])).toEqual(
      [
        [lostId, 'actual'],
        [wonId, 'claimed'],
      ].sort(([a], [b]) => String(a).localeCompare(String(b))),
    );
  });

  // ─── Case 8: ON CONFLICT ─────────────────────────────────────────────────

  it('applies ON CONFLICT inside the owning transaction', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const keepId = uniqueId('host-conflict-keep');
    const upsertId = uniqueId('host-conflict-upsert');
    const rollbackKeepId = uniqueId('host-conflict-rb-keep');
    const rollbackUpsertId = uniqueId('host-conflict-rb-upsert');
    await ctx.db.insert(kv).values([
      { id: keepId, label: 'original', payload: {} },
      { id: upsertId, label: 'original', payload: {} },
      { id: rollbackKeepId, label: 'original', payload: {} },
      { id: rollbackUpsertId, label: 'original', payload: {} },
    ]);

    /**
     * Apply both conflict strategies on the given existing ids.
     * @param context - Query context of the owning transaction.
     * @param ids - Ids of the rows: `keep` names the row whose insert must be ignored, `upsert` the row whose insert must update it.
     */
    async function applyConflicts(
      context: TransactionQueryContext,
      ids: { readonly keep: string; readonly upsert: string },
    ): Promise<void> {
      await context.insert(kv).values({ id: ids.keep, label: 'ignored', payload: {} }).onConflictDoNothing();
      await context
        .insert(kv)
        .values({ id: ids.upsert, label: 'ignored', payload: {} })
        .onConflictDoUpdate({ target: kv.id, set: { label: 'upserted' } });
    }

    await hostDb.transaction(async (tx) => {
      await applyConflicts(getTransactionQueryContext(tx), { keep: keepId, upsert: upsertId });
    });

    const committed = await readRows(ctx.db, [keepId, upsertId]);
    expect(Object.fromEntries(committed.map((row) => [row.id, row.label]))).toEqual({
      [keepId]: 'original',
      [upsertId]: 'upserted',
    });

    await expect(
      hostDb.transaction(async (tx) => {
        await applyConflicts(getTransactionQueryContext(tx), { keep: rollbackKeepId, upsert: rollbackUpsertId });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const rolledBack = await readRows(ctx.db, [rollbackKeepId, rollbackUpsertId]);
    expect(rolledBack.map((row) => row.label)).toEqual(['original', 'original']);
  });

  // ─── Case 9: rollback ────────────────────────────────────────────────────

  it('rolls back every write when the callback throws', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const id1 = uniqueId('host-rollback-1');
    const id2 = uniqueId('host-rollback-2');
    const afterId = uniqueId('host-rollback-after');
    const original = new Error('forced rollback');

    let caught: unknown;
    try {
      await hostDb.transaction(async (tx) => {
        const context = getTransactionQueryContext(tx);
        await context.insert(kv).values({ id: id1, label: 'rollback', payload: {} });
        await context.insert(kv).values({ id: id2, label: 'rollback', payload: {} });
        throw original;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(original);
    expect(caught).not.toBeInstanceOf(HostTransactionError);
    expect(await readRows(ctx.db, [id1, id2])).toHaveLength(0);

    // The handle is not poisoned: a later transaction works.
    await hostDb.transaction(async (tx) => {
      await getTransactionQueryContext(tx).insert(kv).values({ id: afterId, label: 'after', payload: {} });
    });
    expect(await readRows(ctx.db, [afterId])).toHaveLength(1);
  });

  // ─── Case 10: dual schema ────────────────────────────────────────────────

  it('resolves a dual schema by the dialect of the context', async () => {
    const ctx = getCtx();
    const hostDb = createHostDatabase(ctx.db);
    const id = uniqueId('host-schema');

    await hostDb.transaction(async (tx) => {
      const context = getTransactionQueryContext(tx);
      const { kv } = resolveSchema(context, fixtureKv);

      expect(kv).toBe(resolveSchema(ctx.db, fixtureKv).kv);

      await context.insert(kv).values({ id, label: 'created', payload: { n: 1 } });
      expect(await context.select().from(kv).where(eq(kv.id, id))).toHaveLength(1);
      await context.update(kv).set({ label: 'updated' }).where(eq(kv.id, id));
    });

    const rows = await readRows(ctx.db, [id]);
    expect(rows.map((row) => row.label)).toEqual(['updated']);

    await hostDb.transaction(async (tx) => {
      const context = getTransactionQueryContext(tx);
      const { kv } = resolveSchema(context, fixtureKv);
      await context.delete(kv).where(eq(kv.id, id));
    });
    expect(await readRows(ctx.db, [id])).toHaveLength(0);
  });

  // ─── Case 11: result and commit ──────────────────────────────────────────

  it('returns the callback result and commits its writes', async () => {
    const ctx = getCtx();
    const { kv } = resolveSchema(ctx.db, fixtureKv);
    const hostDb = createHostDatabase(ctx.db);
    const id1 = uniqueId('host-commit-1');
    const id2 = uniqueId('host-commit-2');

    const result = await hostDb.transaction(async (tx) => {
      const context = getTransactionQueryContext(tx);
      await context.insert(kv).values({ id: id1, label: 'commit-a', payload: { x: 1 } });
      await context.insert(kv).values({ id: id2, label: 'commit-b', payload: { x: 2 } });
      return { answer: 42 };
    });

    expect(result).toEqual({ answer: 42 });
    expect(await readRows(ctx.db, [id1, id2])).toHaveLength(2);
  });

  // ─── Case 12: SQLITE_BUSY (SQLite only) ──────────────────────────────────

  it.skipIf(config.dialect !== 'sqlite')(
    'keeps the guarantee on a handle that met SQLITE_BUSY',
    async () => {
      const ctx = getCtx();
      const { kv } = resolveSchema(ctx.db, fixtureKv);
      const hostDb = createHostDatabase(ctx.db);
      const holderId = uniqueId('host-busy-holder');
      const busyId = uniqueId('host-busy-plain');
      const txId = uniqueId('host-busy-tx');
      const escapedId = uniqueId('host-busy-escaped');

      const holderClient = await ctx.createSiblingClient();
      const fresh = await ctx.createSiblingClient();
      const holderKv = resolveSchema(holderClient.db, fixtureKv).kv;

      // The sibling holds a write transaction: it wrote a row and waits on the
      // gate. The harness offers no raw BEGIN IMMEDIATE hook (a sibling is
      // `{ db, executor, close }`), so the lock is held by an open
      // `executeTransaction` on the sibling handle.
      const entered = createGate();
      const release = createGate();
      const holder = executeTransaction(holderClient.db, async (tx) => {
        await tx.insert(holderKv).values({ id: holderId, label: 'holder', payload: {} });
        entered.open();
        await release.opened;
      });

      let busyError: unknown;
      try {
        await Promise.race([entered.opened, holder]);

        // Plain autocommit write on the suite handle while the lock is held:
        // expected to fail with a busy error after the handle's busy timeout.
        try {
          await ctx.db.insert(kv).values({ id: busyId, label: 'busy', payload: {} });
        } catch (error) {
          busyError = error;
        }
      } finally {
        release.open();
        await holder;
      }

      expect(busyError).toBeDefined();
      expect(messageChain(busyError)).toMatch(/SQLITE_BUSY|database is locked|busy/i);

      // Escaped builder created in a transaction that ran after the busy failure.
      const escaped: PromiseLike<unknown>[] = [];
      const outcome = await hostDb
        .transaction(async (tx) => {
          const context = getTransactionQueryContext(tx);
          escaped.push(context.insert(kv).values({ id: escapedId, label: 'escaped', payload: {} }));
          await context.insert(kv).values({ id: txId, label: 'tx', payload: {} });
        })
        .then(
          () => 'resolved' as const,
          () => 'rejected' as const,
        );

      // Invariant, not one outcome: resolved means durable, rejected means absent.
      const durable = await readRows(fresh.db, [txId]);
      expect(durable).toHaveLength(outcome === 'resolved' ? 1 : 0);

      expect(escaped).toHaveLength(1);
      await expectFailsWith(() => escaped[0], 'transaction-finished');

      const rows = await readRows(fresh.db, [holderId, busyId, txId, escapedId]);
      const expectedIds = outcome === 'resolved' ? [holderId, txId] : [holderId];
      expect(rows.map((row) => row.id).sort()).toEqual(expectedIds.sort());
    },
    30_000,
  );
});
