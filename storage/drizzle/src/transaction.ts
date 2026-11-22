import { AsyncLocalStorage } from 'node:async_hooks';
import { isUnboundBunSqliteHandle } from './engine/sqlite/unbound-bun-handle';
import { isHandleHeldByCaller } from './raw-sql';
import { ReentrantOperationError } from './reentrant-operation-error';
import type { MakaioDatabase } from './types';

// Derive the canonical transaction callback type from MakaioDatabase, which is
// LibSQLDatabase — the async dialect.  Its transaction() accepts callbacks that
// return T | Promise<T> and itself returns Promise<T>.  This is the widest
// (async-compatible) contract covering all existing call sites written as
// `async (tx) => { await tx.insert(...) }`.
//
// At runtime, when running under Bun, `db` is actually a BunSQLiteDatabase
// cast to MakaioDatabase.  The SQLite client factory binds its synchronous
// transaction() to the async contract (see executeTransaction), so the same
// contract holds on both drivers.
type LibSQLTransactionExecutor = MakaioDatabase['transaction'];

/**
 * Transaction callback that receives Drizzle's transaction context.
 *
 * Typed against the libsql async transaction context, which is the widest
 * compatible contract.  Callbacks written against this type work on both the
 * libsql (Node.js) and bun-sqlite (Bun) drivers: the bun-sqlite statements are
 * synchronous, and `await syncValue` is a JavaScript no-op.
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
 * The queue slot one in-flight {@link serializeByKey} call holds.
 *
 * The slot travels in the async context of the work it guards, so a call made
 * from that work (or anything it starts) can recognize that it is about to
 * queue behind itself.
 */
interface HeldSlot {
  /** Queue store the slot belongs to. */
  readonly tails: object;
  /** Key the slot serializes. */
  readonly key: unknown;
  /** Slot of the work this work was started from, if that was queued work too. */
  readonly outer: HeldSlot | undefined;
  /** Set once the work settled: contexts that outlive it (timers) no longer hold the slot. */
  released: boolean;
}

/** Slots held by the current async context, innermost first. */
const heldSlots = new AsyncLocalStorage<HeldSlot>();

/**
 * Whether the current async context runs inside work that holds a key's slot.
 * @param tails - Queue store of the key.
 * @param key - Identity about to be queued on.
 * @returns `true` when queueing on it would wait for the caller itself.
 */
function holdsSlot(tails: object, key: unknown): boolean {
  for (let slot = heldSlots.getStore(); slot !== undefined; slot = slot.outer) {
    if (slot.tails === tails && sameKey(slot.key, key) && !slot.released) return true;
  }
  return false;
}

/**
 * Whether two keys are the same queue key.
 *
 * Uses SameValueZero, the identity `Map` and `WeakMap` (the stores callers
 * pass) give keys: it differs from `===` only for `NaN`, which a store treats
 * as itself, so a nested request for it queues behind its own slot.
 * @param held - Key of the slot the caller holds.
 * @param requested - Key being queued on.
 * @returns `true` when a store would hold both under one entry.
 */
function sameKey(held: unknown, requested: unknown): boolean {
  return held === requested || (Number.isNaN(held) && Number.isNaN(requested));
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
 * **Re-entrancy:** a call made from inside work this queue is running for the
 * same key (the work, or anything it started, asks for the key again) would
 * wait for the work that waits for it. It is rejected with a
 * {@link ReentrantOperationError} before it queues. Work that outlives its slot
 * (a timer fired after the work settled) queues normally. Only cycles through
 * one async context are detectable: work that awaits a promise started
 * elsewhere which in turn queues on the same key cannot be told apart from
 * unrelated work, so queued work must not wait for other work on its key.
 *
 * The guarantee is process-local: two processes over one database do not share
 * a store and must coordinate through the database itself.
 * @param tails - Store holding the in-flight tail per key.
 * @param key - Identity this work must not overlap other work on.
 * @param work - Async work to run once the queue reaches it.
 * @returns Whatever `work` resolves to.
 * @throws ReentrantOperationError when called from inside work holding the same key.
 * @typeParam TKey - Identity operations are serialized against.
 * @typeParam TResult - Result type produced by the work.
 */
export async function serializeByKey<TKey, TResult>(
  tails: OperationTailStore<TKey>,
  key: TKey,
  work: () => Promise<TResult>,
): Promise<TResult> {
  // Decided before anything is published or awaited: a rejected re-entrant
  // call leaves the queue exactly as it found it.
  if (holdsSlot(tails, key)) throw ReentrantOperationError.forQueue();

  const previousTail = tails.get(key) ?? Promise.resolve();
  const release = Promise.withResolvers<void>();
  const nextTail = previousTail.catch(() => undefined).then(() => release.promise);
  tails.set(key, nextTail);

  await previousTail.catch(() => undefined);
  const slot: HeldSlot = { tails, key, outer: heldSlots.getStore(), released: false };
  try {
    return await heldSlots.run(slot, work);
  } finally {
    slot.released = true;
    release.resolve();
    if (tails.get(key) === nextTail) tails.delete(key);
  }
}

/**
 * Serialize one database operation with transactions using the same handle.
 *
 * Rejects with a {@link ReentrantOperationError} instead of waiting when the
 * caller already holds the handle: inside a transaction or serialized
 * operation of this handle, or inside a SQLite raw session or transaction
 * callback, which hold the handle itself. In the last case the cycle can close
 * through the queue even when the queue is free right now, because an
 * operation that queued first and waits for the handle would be waiting for
 * the caller as well.
 * @param db - Makaio database instance.
 * @param operation - Async database work that must not overlap a transaction.
 * @returns Result returned by the operation.
 * @throws ReentrantOperationError when called from inside work holding the handle.
 */
export async function serializeDatabaseOperation<T>(db: MakaioDatabase, operation: () => Promise<T>): Promise<T> {
  if (isHandleHeldByCaller(db)) throw ReentrantOperationError.forHandle();
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
 * **Atomicity contract:** every statement the callback awaits commits
 * together when it resolves and rolls back together when it rejects, on every
 * driver. The same holds for a nested `tx.transaction()`, which is a savepoint
 * and rolls back only its own statements. `MakaioDatabase` is typed as
 * `LibSQLDatabase` (Node.js async dialect), which holds the transaction across
 * the callback's awaits. At runtime under Bun, `db` is a `BunSQLiteDatabase`
 * cast to `MakaioDatabase`, whose native transaction would commit at the
 * callback's first `await`; the SQLite client factory binds it to this
 * contract, and a handle that was never bound this way is rejected instead of
 * silently losing atomicity.
 *
 * **Isolation contract (SQLite handles only):** while a transaction is open
 * on a handle, statements issued on that handle from outside the callback —
 * plain statements, raw `BEGIN` sessions (`RawSqlExecutor.withSession`), other
 * transactions — wait until it committed or rolled back. They neither join it
 * nor observe its uncommitted writes, and they never fail with SQLITE_BUSY
 * because of it. The SQLite client factory enforces this per handle on both
 * drivers with one serialization gate; without it, `bun:sqlite` (single
 * connection) would run them inside the transaction and libsql (second
 * connection) would block the event loop until the busy timeout. Statements
 * the callback issues itself are never held back: use the transaction context
 * (`tx`) for them. A statement issued on `db` from inside the callback is not
 * held back either, but on libsql it runs on the handle's other connection
 * and a write meets the transaction's write lock. Postgres handles have no
 * such gate: their transactions are isolated by MVCC on a pooled connection
 * of their own. The nested transactions of one transaction context
 * (savepoints) run one at a time in request order.
 *
 * **Constraint:** a transaction callback contains database work only. It must
 * not await work started outside it that uses the same handle (bus requests,
 * other queued operations): that work waits for the transaction, which waits
 * for the callback, and both stall. Requesting a transaction, a serialized
 * operation or a raw session on the same handle from inside the callback is
 * enforced: it is rejected with a {@link ReentrantOperationError}. Work started
 * elsewhere that waits for this handle cannot be detected (the cycle runs
 * through promises, not through the callback's async context), so the
 * constraint remains the contract there.
 * @param db - Makaio database instance
 * @param callback - Transaction work to execute
 * @returns Result returned by the callback
 * @throws ReentrantOperationError when called from inside work holding the handle.
 * @throws Error when `db` is a bun-sqlite handle whose `transaction()` was never
 *   bound to this atomicity contract (see {@link isUnboundBunSqliteHandle}).
 */
export async function executeTransaction<T>(db: MakaioDatabase, callback: TransactionCallback<T>): Promise<T> {
  if (isUnboundBunSqliteHandle(db)) {
    throw new Error(
      'executeTransaction received an unbound bun-sqlite handle: its transaction() commits at the ' +
        "callback's first await instead of holding across every awaited statement. Create the handle " +
        'with createDatabaseClient instead of a hand-rolled drizzle-orm/bun-sqlite instance.',
    );
  }
  return serializeDatabaseOperation(db, () => db.transaction(callback));
}

const operationTails = new WeakMap<MakaioDatabase, Promise<void>>();
