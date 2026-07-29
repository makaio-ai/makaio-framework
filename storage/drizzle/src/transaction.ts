import type { MakaioDatabase } from './types';

// Derive the canonical transaction callback type from MakaioDatabase, which is
// LibSQLDatabase — the async dialect.  Its transaction() accepts callbacks that
// return T | Promise<T> and itself returns Promise<T>.  This is the widest
// (async-compatible) contract covering all existing call sites written as
// `async (tx) => { await tx.insert(...) }`.
//
// At runtime, when running under Bun, `db` is actually a BunSQLiteDatabase
// cast to MakaioDatabase.  BunSQLiteDatabase.transaction() propagates whatever
// the callback returns, so passing an async callback causes it to return
// Promise<T>, which `await` in executeTransaction() unwraps normally.
type LibSQLTransactionExecutor = MakaioDatabase['transaction'];

/**
 * Transaction callback that receives Drizzle's transaction context.
 *
 * Typed against the libsql async transaction context, which is the widest
 * compatible contract.  Callbacks written against this type work on both the
 * libsql (Node.js) and bun-sqlite (Bun) drivers because `await syncValue` is
 * a JavaScript no-op.
 * @typeParam T - Callback result type
 */
export type TransactionCallback<T> = Parameters<LibSQLTransactionExecutor>[0] extends (
  tx: infer TTx,
) => Promise<unknown>
  ? (tx: TTx) => Promise<T>
  : never;

/**
 * Keyed store of in-flight operation tails.
 *
 * Declared structurally so a caller may choose the keyspace its identity
 * actually lives in: both `Map` and `WeakMap` satisfy it, so a caller keyed on
 * an object holds no strong reference to it, while a caller keyed on a derived
 * value (a file path, a connection identity) still gets a queue.
 * @typeParam TKey - Identity operations are serialized against.
 */
export interface OperationTailStore<TKey> {
  /**
   * Read the tail currently queued for a key.
   * @param key - Identity to read.
   * @returns The queued tail, or `undefined` when nothing is in flight.
   */
  get(key: TKey): Promise<void> | undefined;
  /**
   * Publish the new tail for a key.
   * @param key - Identity to write.
   * @param tail - Tail that resolves once the newly queued work has finished.
   */
  set(key: TKey, tail: Promise<void>): unknown;
  /**
   * Drop a key whose queue has drained.
   * @param key - Identity to forget.
   */
  delete(key: TKey): unknown;
}

/**
 * Run work as the only in-flight operation for a key.
 *
 * The queue is a chain of tails: each caller reads the tail currently
 * published for its key, publishes its own, and waits for the one it read.
 * A rejected predecessor is absorbed rather than propagated, because a failed
 * operation still releases the queue for the next one. The key is dropped only
 * when the tail still published is the one this call wrote, so a successor
 * that already queued behind it is never orphaned.
 *
 * The guarantee is process-local: two processes over one database do not share
 * a store and must coordinate through the database itself.
 * @param tails - Store holding the in-flight tail per key.
 * @param key - Identity this work must not overlap other work on.
 * @param work - Async work to run once the queue reaches it.
 * @returns Whatever `work` resolves to.
 * @typeParam TKey - Identity operations are serialized against.
 * @typeParam TResult - Result type produced by the work.
 */
export async function serializeByKey<TKey, TResult>(
  tails: OperationTailStore<TKey>,
  key: TKey,
  work: () => Promise<TResult>,
): Promise<TResult> {
  const previousTail = tails.get(key) ?? Promise.resolve();
  const release = Promise.withResolvers<void>();
  const nextTail = previousTail.catch(() => undefined).then(() => release.promise);
  tails.set(key, nextTail);

  await previousTail.catch(() => undefined);
  try {
    return await work();
  } finally {
    release.resolve();
    if (tails.get(key) === nextTail) tails.delete(key);
  }
}

/**
 * Serialize one database operation with transactions using the same handle.
 * @param db - Makaio database instance.
 * @param operation - Async database work that must not overlap a transaction.
 * @returns Result returned by the operation.
 */
export async function serializeDatabaseOperation<T>(db: MakaioDatabase, operation: () => Promise<T>): Promise<T> {
  return serializeByKey(operationTails, db, operation);
}

/**
 * Execute a database transaction through a shared transaction seam.
 *
 * **Serialization contract:** transaction callbacks are serialized per
 * database handle within this process, on every dialect. SQLite needs the
 * queue for single-writer safety — it permits only one active transaction
 * per connection, and without the queue concurrent bus handlers fail at
 * `BEGIN` with SQLITE_BUSY before busy_timeout can help. Postgres needs the
 * queue so read-modify-write callbacks observe each other's commits: MVCC
 * runs concurrent transactions against isolated snapshots, so two unqueued
 * "read current state, then write" callbacks (e.g. clear the old default
 * row, then mark the new one) can both act on the same stale read. The
 * guarantee is process-local — multi-process Postgres deployments need
 * database-level coordination (advisory locks or unique-constraint retries)
 * at the caller seam.
 *
 * **Driver compatibility:** `MakaioDatabase` is typed as `LibSQLDatabase`
 * (Node.js async dialect), which runs the transaction asynchronously and
 * returns `Promise<T>`.  At runtime under Bun, `db` is a `BunSQLiteDatabase`
 * cast to `MakaioDatabase`; the sync dialect propagates the async callback's
 * return value, so the transaction still resolves as `Promise<T>`, which
 * `await` unwraps normally.
 * @param db - Makaio database instance
 * @param callback - Transaction work to execute
 * @returns Result returned by the callback
 */
export async function executeTransaction<T>(db: MakaioDatabase, callback: TransactionCallback<T>): Promise<T> {
  return serializeDatabaseOperation(db, () => db.transaction(callback));
}

const operationTails = new WeakMap<MakaioDatabase, Promise<void>>();
