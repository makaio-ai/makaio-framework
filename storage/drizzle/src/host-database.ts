/**
 * Host database seam: `HostTransaction` minting and query-context lookup.
 * @packageDocumentation
 */

import type { SQL } from 'drizzle-orm';
import type { RawSqlSession } from './raw-sql';
import type { HostDatabase, HostTransaction } from '@makaio/contracts';
import { HostTransactionError } from './host-transaction';
import type { DriverTransaction, TransactionQueryContext } from './host-transaction';
import { executeTransaction } from './transaction';
import { createGuardedTransactionView } from './transaction-query-session';
import type { MakaioDatabase } from './types';
import { getDatabaseDialect } from './types';

/** Lifetime of one transaction's authorization. */
interface Lifetime {
  /** Set once the `transaction(fn)` callback settled. */
  finished: boolean;
}

/** What the storage owner knows about one minted `HostTransaction`. */
interface TransactionState {
  /** Database handle on which the host opened this transaction. */
  readonly db: MakaioDatabase;
  /** Query surface bound to the driver transaction. */
  readonly context: TransactionQueryContext;
  readonly driver: DriverTransaction;
  /** Authorization lifetime the context's guard reads. */
  readonly lifetime: Lifetime;
}

/** A freshly minted `HostTransaction` with the lifetime to end when its callback settled. */
interface MintedTransaction {
  /** The opaque transaction handed to the callback. */
  readonly hostTx: HostTransaction;
  /** Authorization lifetime of that transaction. */
  readonly lifetime: Lifetime;
}

/** Every `HostTransaction` minted by this module; anything else is foreign. */
const transactions = new WeakMap<HostTransaction, TransactionState>();

/**
 * Build the error for a query attempted after the transaction ended.
 * @returns The `transaction-finished` error.
 */
function transactionFinishedError(): HostTransactionError {
  return new HostTransactionError(
    'transaction-finished',
    'The host transaction already ended: its callback settled, so no query may run in it any more.',
  );
}

/**
 * Mint the `HostTransaction` of one driver transaction and register its state.
 * @param db - Handle the transaction was opened on.
 * @param tx - Driver transaction handed out by `executeTransaction`.
 * @returns The minted transaction and the lifetime to end when its callback settled.
 */
function mintHostTransaction(db: MakaioDatabase, tx: DriverTransaction): MintedTransaction {
  const lifetime: Lifetime = { finished: false };
  const {
    select,
    insert,
    update,
    delete: remove,
  } = createGuardedTransactionView(tx, () => {
    if (lifetime.finished) throw transactionFinishedError();
  });
  const context: TransactionQueryContext = Object.freeze({
    dialect: getDatabaseDialect(db),
    select,
    insert,
    update,
    delete: remove,
  });
  // The single sanctioned assertion: `HostTransaction` is an opaque brand that only
  // the storage owner may mint, so no structurally valid value exists to build it from.
  const hostTx = Object.freeze({}) as HostTransaction;
  transactions.set(hostTx, { db, context, driver: tx, lifetime });
  return { hostTx, lifetime };
}

/**
 * Create the host database seam over a database handle.
 *
 * Each `transaction(fn)` call mints one `HostTransaction`, bound to the driver
 * transaction it opened and to the dialect of the handle. The transaction is
 * committed when `fn` fulfils and rolled back when it rejects. The
 * authorization of the `HostTransaction` ends when `fn` fulfilled or rejected,
 * before the commit or rollback statement is issued: from then on every query
 * made through it fails with a `HostTransactionError`.
 *
 * Transactions are queued per handle (see `executeTransaction`), so the
 * `HostDatabase` must be created from the handle the host itself writes on.
 * @param db - Handle the host writes its own state on.
 * @returns The host database seam of that handle.
 */
export function createHostDatabase(db: MakaioDatabase): HostDatabase {
  return {
    transaction: (fn) =>
      executeTransaction(db, async (tx) => {
        const { hostTx, lifetime } = mintHostTransaction(db, tx);
        try {
          return await fn(hostTx);
        } finally {
          lifetime.finished = true;
        }
      }),
  };
}

/**
 * Resolve the query context of a host transaction.
 *
 * Every builder and prepared query created through the context runs in exactly
 * that transaction. After the transaction ended, executing one fails with a
 * `HostTransactionError` (`transaction-finished`) before the database is
 * touched: nothing runs in autocommit and nothing runs in another transaction.
 * The guarantee binds the public methods of the context and of the builders; reaching
 * into their non-public fields is outside it. The builder types are the canonical SQLite
 * view (house convention, see `dialect.ts`), so the SQLite-only terminal methods
 * (`run`, `get`, `values`) are not available on a Postgres handle.
 * @param tx - Host transaction received from `HostDatabase.transaction`.
 * @returns The query context bound to that transaction.
 * @throws A `HostTransactionError` (`foreign-transaction`) when `tx` was not minted by `createHostDatabase`.
 * @throws A `HostTransactionError` (`transaction-finished`) when the transaction already ended.
 */
export function getTransactionQueryContext(tx: HostTransaction): TransactionQueryContext {
  return requireTransactionState(tx).context;
}

/**
 * Resolve a live host transaction and its underlying storage state.
 * @param tx - Host transaction to authorize.
 * @returns State owned by the storage facade.
 */
function requireTransactionState(tx: HostTransaction): TransactionState {
  const state = transactions.get(tx);
  if (state === undefined) {
    throw new HostTransactionError(
      'foreign-transaction',
      'The value is not a host transaction minted by createHostDatabase.',
    );
  }
  if (state.lifetime.finished) throw transactionFinishedError();
  return state;
}

/**
 * Adapt a PostgreSQL host transaction for storage implementations that use raw SQL.
 * Each statement checks that the host callback still owns the driver transaction.
 * @param tx - Transaction supplied by the host database callback.
 * @param db - Database handle the adapter writes through.
 * @returns Raw SQL session on the same pinned connection.
 * @throws A `HostTransactionError` (`foreign-transaction`) when `tx` was not minted by `createHostDatabase`.
 * @throws A `HostTransactionError` (`transaction-finished`) when the transaction already ended.
 * @throws A `HostTransactionError` (`transaction-dialect-unsupported`) when the host is not using PostgreSQL.
 * @throws A `HostTransactionError` (`transaction-database-mismatch`) when the transaction belongs to another database handle.
 * @throws A `HostTransactionError` (`transaction-result-invalid`) when the driver cannot provide a valid query result.
 *   The session's `run` and `all` can throw this error after the statement has executed.
 * @internal
 */
export function getPostgresHostTransactionSession(tx: HostTransaction, db: MakaioDatabase): RawSqlSession {
  const state = requireTransactionState(tx);
  if (state.context.dialect !== 'postgres') {
    throw new HostTransactionError('transaction-dialect-unsupported', 'Expected a PostgreSQL host transaction');
  }
  if (state.db !== db) {
    throw new HostTransactionError(
      'transaction-database-mismatch',
      'The host transaction belongs to another database handle',
    );
  }
  // The portable Drizzle type uses SQLite builders. PostgreSQL transactions
  // execute through the pinned client, and their result is checked below.
  const driver = state.driver as DriverTransaction & { execute?: (query: SQL) => PromiseLike<unknown> };
  const { execute } = driver;
  if (typeof execute !== 'function') {
    throw new HostTransactionError('transaction-result-invalid', 'PostgreSQL host transaction has no execute method');
  }
  const executeLive = async (query: SQL): Promise<object> => {
    requireTransactionState(tx);
    const result = await execute.call(driver, query);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new HostTransactionError('transaction-result-invalid', 'Expected a PostgreSQL query result');
    }
    return result;
  };
  return {
    async run(query) {
      const result = await executeLive(query);
      const count = 'rowCount' in result ? result.rowCount : undefined;
      return { rowsAffected: typeof count === 'number' ? count : 0 };
    },
    async all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
      const result = await executeLive(query);
      if (!('rows' in result) || !Array.isArray(result.rows)) {
        throw new HostTransactionError('transaction-result-invalid', 'Expected PostgreSQL result rows');
      }
      return result.rows as TRow[];
    },
  };
}
