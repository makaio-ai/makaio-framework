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
 * This is currently a pass-through to `db.transaction()`. Keeping transaction
 * calls behind this helper gives us one extension point for future write
 * serialization (mutex/queue/pool) without changing handler call sites.
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
  return db.transaction(callback);
}
