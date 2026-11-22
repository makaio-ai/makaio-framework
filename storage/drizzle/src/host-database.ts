/**
 * Host database seam: `HostTransaction` minting and query-context lookup.
 * @packageDocumentation
 */

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
  /** Query surface bound to the driver transaction. */
  readonly context: TransactionQueryContext;
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
  transactions.set(hostTx, { context, lifetime });
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
  const state = transactions.get(tx);
  if (state === undefined) {
    throw new HostTransactionError(
      'foreign-transaction',
      'The value is not a host transaction minted by createHostDatabase.',
    );
  }
  if (state.lifetime.finished) throw transactionFinishedError();
  return state.context;
}
