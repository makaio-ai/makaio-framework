/**
 * Host database seam: `HostTransaction` minting and query-context lookup.
 * @packageDocumentation
 */

import { sql, type SQL } from 'drizzle-orm';
import type { RawSqlSession } from './raw-sql';
import type { HostDatabase, HostTransaction } from '@makaio/contracts';
import { getDatabaseSignals } from './database-signals';
import { deliverLocalWakeTopics, registerHostDatabaseHandle } from './host-database-wake';
import { HostTransactionError } from './host-transaction';
import type { DriverTransaction, TransactionQueryContext } from './host-transaction';
import { executeTransaction } from './transaction';
import { createGuardedTransactionView } from './transaction-query-session';
import type { MakaioDatabase } from './types';
import { getDatabaseDialect } from './types';

/** What the storage owner knows about one minted `HostTransaction`. */
interface TransactionState {
  /** Facade that minted the transaction. */
  readonly host: HostDatabase;
  /** Database handle and driver transaction used by the PostgreSQL storage adapter. */
  readonly db: MakaioDatabase;
  readonly driver: DriverTransaction;
  /** Query surface bound to the driver transaction. */
  readonly context: TransactionQueryContext;
  readonly signal: AbortSignal | undefined;
  /** Set once the `transaction(fn)` callback settled. */
  finished: boolean;
  /** Error that causes a fulfilled callback to roll back. */
  rollbackCause?: Error;
  /** Topics marked on this transaction via `markTransactionWakeTopic`, deduplicated. Fresh per minted transaction. */
  readonly wakeTopics: Set<string>;
}

/** A freshly minted transaction and its state. */
interface MintedTransaction {
  /** Opaque transaction passed to the callback. */
  readonly hostTx: HostTransaction;
  /** State held in the transaction registry. */
  readonly state: TransactionState;
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
 * @param host - Facade that owns the transaction.
 * @param db - Handle the transaction was opened on.
 * @param tx - Driver transaction handed out by `executeTransaction`.
 * @param signal - Lifetime of the transaction's work, up to commit.
 * @returns The minted transaction and its state.
 */
function mintHostTransaction(
  host: HostDatabase,
  db: MakaioDatabase,
  tx: DriverTransaction,
  signal: AbortSignal | undefined,
): MintedTransaction {
  const {
    select,
    insert,
    update,
    delete: remove,
  } = createGuardedTransactionView(tx, (afterExecution) => {
    if (!afterExecution && state.finished) throw transactionFinishedError();
    signal?.throwIfAborted();
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
  const state: TransactionState = { host, db, driver: tx, context, signal, finished: false, wakeTopics: new Set() };
  transactions.set(hostTx, state);
  return { hostTx, state };
}

/**
 * Run one `transaction(fn)` call: mint its `HostTransaction`, end its
 * authorization once `fn` settled, notify any topics it marked, and — only
 * after the transaction committed — deliver those topics to this process's
 * own wake listeners.
 * @param host - Facade that owns the transaction.
 * @param db - Handle the transaction runs on.
 * @param fn - Callback the minted `HostTransaction` is handed to.
 * @param signal - Lifetime of the transaction's work, up to commit.
 * @returns Whatever `fn` resolved to.
 * @typeParam T - Result type of `fn`.
 */
async function runHostTransaction<T>(
  host: HostDatabase,
  db: MakaioDatabase,
  fn: (hostTx: HostTransaction) => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  let committedTopics: ReadonlySet<string> | undefined;

  const result = await executeTransaction(
    db,
    async (tx) => {
      signal?.throwIfAborted();
      const { hostTx, state } = mintHostTransaction(host, db, tx, signal);
      let fnResult: T;
      try {
        fnResult = await fn(hostTx);
      } finally {
        state.finished = true;
      }

      if (state.rollbackCause !== undefined) throw state.rollbackCause;
      signal?.throwIfAborted();

      const { wakeTopics } = state;
      if (wakeTopics.size > 0) {
        const signals = getDatabaseSignals(db);
        if (signals.kind === 'database-notify') {
          // Original driver transaction parameter, not the guarded view (whose
          // authorization already ended above) and not the raw SQL executor —
          // the portable select pattern of `transaction-locks.ts`.
          for (const topic of wakeTopics) {
            await tx.select({ notified: signals.notifyExpression(topic) }).from(sql.raw('(SELECT 1) AS wake_anchor'));
            signal?.throwIfAborted();
          }
        }
        committedTopics = wakeTopics;
      }

      return fnResult;
    },
    signal,
  );

  if (committedTopics !== undefined) {
    deliverLocalWakeTopics(db, committedTopics);
  }
  return result;
}

/**
 * Create the host database seam over a database handle.
 *
 * Each `transaction(fn)` call mints one `HostTransaction`, bound to the driver
 * transaction it opened and to the dialect of the handle. The transaction is
 * committed when `fn` fulfils unless it was marked rollback-only. A rejecting
 * `fn` rolls back with its own error. The `HostTransaction` authorization ends
 * when `fn` settles, before commit or rollback. From then on every query made
 * through it fails with a `HostTransactionError`.
 *
 * A transaction may mark topics on itself (`markTransactionWakeTopic`,
 * internal to this package). Once `fn` fulfils without a rollback cause, marked
 * topics are notified through the handle's signal capability (`database-notify` only) inside the
 * same driver transaction, so delivery to other processes happens exactly
 * when the transaction commits. Only once the transaction has committed are
 * the same topics delivered to this process's own wake listeners (see
 * `getHostDatabaseWake`); a rolled-back transaction, a rejecting `fn`, a
 * failing notify statement, or a failing commit all skip that local delivery.
 *
 * Transactions are queued per handle (see `executeTransaction`), so the
 * `HostDatabase` must be created from the handle the host itself writes on.
 * @param db - Handle the host writes its own state on.
 * @returns The host database seam of that handle.
 */
export function createHostDatabase(db: MakaioDatabase): HostDatabase {
  const host: HostDatabase = {
    transaction: (fn, options) => runHostTransaction(host, db, fn, options?.signal),
  };
  registerHostDatabaseHandle(host, db);
  return host;
}

/**
 * Resolve the state of a live transaction and optionally require its minting facade.
 * @param tx - Host transaction received from `HostDatabase.transaction`.
 * @param host - Facade that must have minted the transaction, if supplied.
 * @returns The live transaction state.
 */
function requireTransactionState(tx: HostTransaction, host?: HostDatabase): TransactionState {
  const state = transactions.get(tx);
  if (state === undefined || (host !== undefined && state.host !== host)) {
    throw new HostTransactionError(
      'foreign-transaction',
      'The value was not minted by createHostDatabase or belongs to another host database facade.',
    );
  }
  if (state.finished) throw transactionFinishedError();
  return state;
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
    state.signal?.throwIfAborted();
    const result = await execute.call(driver, query);
    state.signal?.throwIfAborted();
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

/**
 * Resolve the query context only for a live transaction minted by `host`.
 *
 * Each facade has its own transaction authority, including facades over the
 * same handle. Those facades share wake delivery and the driver's transaction queue.
 * @param host - Facade that must have minted the transaction.
 * @param tx - Host transaction received from `HostDatabase.transaction`.
 * @returns The query context bound to the transaction.
 * @throws A `HostTransactionError` (`foreign-transaction`) when `host` did not mint `tx`.
 * @throws A `HostTransactionError` (`transaction-finished`) when `tx` belongs to `host` and already ended.
 * @internal
 */
export function getHostTransactionQueryContext(host: HostDatabase, tx: HostTransaction): TransactionQueryContext {
  return requireTransactionState(tx, host).context;
}

/**
 * Mark a topic on a host transaction: once the transaction commits, it is
 * notified through the handle's signal capability (when available) and
 * delivered to this process's own wake listeners. Marking the same topic more
 * than once on a transaction has no additional effect.
 * @param tx - Host transaction received from `HostDatabase.transaction`.
 * @param topic - Application-defined topic to notify at commit.
 * @throws A `HostTransactionError` (`foreign-transaction`) when `tx` was not minted by `createHostDatabase`.
 * @throws A `HostTransactionError` (`transaction-finished`) when the transaction already ended.
 */
export function markTransactionWakeTopic(tx: HostTransaction, topic: string): void {
  requireTransactionState(tx).wakeTopics.add(topic);
}

/**
 * Make a live transaction roll back even if its callback fulfils.
 *
 * The first cause is used if the callback fulfils. A rejecting callback's
 * own error still propagates.
 * @param tx - Host transaction received from `HostDatabase.transaction`.
 * @param cause - Error to throw if the transaction callback fulfils.
 * @throws A `HostTransactionError` (`foreign-transaction`) when `tx` was not minted by `createHostDatabase`.
 * @throws A `HostTransactionError` (`transaction-finished`) when the transaction already ended.
 * @internal
 */
export function markTransactionRollbackOnly(tx: HostTransaction, cause: Error): void {
  requireTransactionState(tx).rollbackCause ??= cause;
}
