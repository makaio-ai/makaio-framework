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
 * Execute a database transaction through a shared transaction seam.
 *
 * Transaction work is serialized per database instance. SQLite permits only
 * one active transaction on a connection; without this queue, concurrent bus
 * handlers can fail at `BEGIN` with SQLITE_BUSY before busy_timeout can help.
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
  const previousTail = transactionTails.get(db) ?? Promise.resolve();
  let releaseCurrent = (): void => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const nextTail = previousTail.catch(() => undefined).then(() => current);
  transactionTails.set(db, nextTail);

  await previousTail.catch(() => undefined);
  try {
    return await db.transaction(callback);
  } finally {
    releaseCurrent();
    if (transactionTails.get(db) === nextTail) {
      transactionTails.delete(db);
    }
  }
}

const transactionTails = new WeakMap<MakaioDatabase, Promise<void>>();
