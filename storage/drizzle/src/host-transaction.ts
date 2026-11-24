/**
 * Types and errors of the host transaction facade.
 * @packageDocumentation
 */

import type { StorageDialect } from './types';
import type { TransactionCallback } from './transaction';

/**
 * Drizzle's transaction context as `executeTransaction` hands it to a callback.
 * @internal Shared between the facade modules of this package; not part of the package index.
 */
export type DriverTransaction = Parameters<TransactionCallback<unknown>>[0];

/** Why a {@link HostTransactionError} was raised. */
export type HostTransactionErrorCode =
  | 'foreign-transaction'
  | 'transaction-finished'
  | 'transaction-dialect-unsupported'
  | 'transaction-database-mismatch'
  | 'transaction-result-invalid';

/**
 * An operation on a `HostTransaction` could not be executed or interpreted.
 *
 * - `foreign-transaction`: the value was not minted by `createHostDatabase`
 *   or was minted by a different facade than the one required.
 * - `transaction-finished`: the `transaction(fn)` call that minted it already
 *   settled, so nothing may run in it any more.
 * - `transaction-dialect-unsupported`: the host uses a dialect that does not support the operation.
 * - `transaction-database-mismatch`: the transaction belongs to a different database handle than the adapter.
 * - `transaction-result-invalid`: the driver did not return the expected result.
 */
export class HostTransactionError extends Error {
  /** Machine-readable reason of the failure. */
  public readonly code: HostTransactionErrorCode;

  /**
   * Create the error.
   * @param code - Machine-readable reason of the failure.
   * @param message - Human-readable diagnosis.
   */
  public constructor(code: HostTransactionErrorCode, message: string) {
    super(message);
    this.name = 'HostTransactionError';
    this.code = code;
  }
}

/**
 * Query surface bound to one open host transaction.
 *
 * Every builder and prepared query created through it runs in exactly that
 * transaction. Once the transaction ended, executing any of them fails with a
 * `HostTransactionError` (`transaction-finished`) before the database is
 * touched: nothing runs in autocommit and nothing runs in another transaction.
 *
 * The guarantee binds the public methods of the context and of the builders it
 * creates; reaching into their non-public fields is outside it.
 *
 * The surface is exactly `select`, `insert`, `update` and `delete` (no raw
 * `execute`, no `rollback`, no nested `transaction`).
 *
 * Limit: like `MakaioDatabase` and the `executeTransaction` callback, the
 * builder types are the canonical SQLite view on every dialect (see
 * `dialect.ts`). The SQLite-only terminals (`run`, `get`, `values`, and the
 * same methods of a prepared query) therefore type-check on a Postgres handle
 * but throw a `TypeError` there at runtime. Portable code awaits the builder
 * (or calls `execute()` on a prepared query) and never calls those terminals.
 */
export type TransactionQueryContext = {
  /** Dialect of the handle the transaction was opened on. */
  readonly dialect: StorageDialect;
} & Pick<DriverTransaction, 'select' | 'insert' | 'update' | 'delete'>;
