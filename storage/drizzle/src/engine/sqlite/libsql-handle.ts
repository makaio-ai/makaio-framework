/**
 * Serialization and connection settings for `@libsql/client` SQLite handles.
 *
 * The libsql client owns one connection at a time. Opening a transaction hands
 * that connection to the transaction and the client opens a new one lazily for
 * the next statement. Two consequences are fixed here:
 *
 * - **Isolation:** the new connection does not see the transaction's
 *   uncommitted writes, but a write on it meets the transaction's write lock,
 *   and because libsql executes synchronously the wait for that lock blocks the
 *   whole event loop until the busy timeout expires. Every statement entry
 *   point of the client therefore passes the handle's {@link HandleGate}, so
 *   statements from outside an open transaction wait asynchronously instead.
 * - **Connection settings:** PRAGMAs such as `busy_timeout` and `foreign_keys`
 *   are per connection. Each connection the client opens after the first one
 *   is configured before anything can use it.
 *
 * Not fixable here: the release of a connection that was handed to a
 * transaction. libsql offers no way to close it. `commit()`, `rollback()` and
 * `close()` of the transaction end the SQL transaction and leave the native
 * connection open until the runtime collects it, and `client.close()` closes
 * only the connection the client holds at that moment. After a transaction,
 * closing a file-backed handle therefore releases the replacement connection
 * deterministically and the transaction's connection at garbage collection.
 * Committed data is durable either way; what is not guaranteed is the moment
 * the operating system file handle goes away (it matters on platforms that
 * refuse to delete an open file). Handles that must release deterministically
 * run on `bun:sqlite`, which keeps one connection for its whole life.
 * @packageDocumentation
 */
import type { InStatement, ResultSet, Transaction, TransactionMode } from '@libsql/client';
import type { HandleGate } from './handle-gate';
import { serializeNestedTransactions, type NestedTransactionScope } from './nested-transactions';
import { attachSecondaryFailure } from './secondary-failure';

/** Statement entry points and connection lifecycle of a libsql client that the handle binding adapts. */
export interface LibsqlClientSurface {
  /**
   * Execute one statement on the client's current connection.
   * @param statement - Statement to execute.
   */
  execute(statement: InStatement): Promise<ResultSet>;
  /**
   * Execute statements in one implicit transaction.
   * @param statements - Statements to execute.
   */
  batch(statements: InStatement[]): Promise<ResultSet[]>;
  /**
   * Execute statements as a migration batch.
   * @param statements - Statements to execute.
   */
  migrate(statements: InStatement[]): Promise<ResultSet[]>;
  /**
   * Execute a script of semicolon-separated statements.
   * @param script - SQL script to execute.
   */
  executeMultiple(script: string): Promise<void>;
  /**
   * Open a transaction on the current connection; the client opens a new one for later statements.
   * @param mode - Transaction mode; libsql defaults to a write transaction.
   */
  transaction(mode?: TransactionMode): Promise<Transaction>;
}

/**
 * Configuration drizzle accepts as the second argument of `db.transaction()`.
 *
 * Drizzle's libsql session currently ignores it and always opens a write
 * transaction. The binding still hands it through untouched so a drizzle
 * release that starts honoring it is not silently turned into a no-op here.
 */
export interface LibsqlTransactionConfig {
  /** Requested SQLite transaction behavior. */
  readonly behavior?: 'deferred' | 'immediate' | 'exclusive';
}

/** Drizzle libsql handle surface adapted by {@link bindLibsqlHandle}. */
export interface LibsqlDatabase<TTransaction> {
  /** The libsql client every statement of the handle runs on. */
  readonly $client: LibsqlClientSurface;
  /**
   * Run a callback inside a transaction (or, inside a transaction, a savepoint).
   * @param callback - Work to run with the transaction context.
   * @param config - Transaction configuration, passed through to drizzle.
   */
  transaction<T>(callback: (tx: TTransaction) => Promise<T>, config?: LibsqlTransactionConfig): Promise<T>;
}

/**
 * Wrap an async client method so it waits for the handle's open transaction.
 * @param gate - Gate of the handle.
 * @param method - Client method, bound to its client.
 * @returns The method, held back while a transaction the caller is not part of is open.
 * @typeParam TArgs - Argument list of the method.
 * @typeParam TResult - Result the method resolves to.
 */
function gated<TArgs extends unknown[], TResult>(
  gate: HandleGate,
  method: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  return async (...args) => await gate.run(() => method(...args));
}

/**
 * Make a drizzle libsql handle honor the isolation and connection-settings
 * contract of `MakaioDatabase`.
 *
 * - `db.transaction()` holds the handle's gate until the transaction settled,
 *   and the nested transactions of each transaction context run one at a time
 *   (see {@link serializeLibsqlNestedTransactions}).
 * - Every statement entry point of the client passes the gate; statements
 *   issued from an open transaction's async context are never held back.
 * - Each connection the client opens after a transaction receives
 *   `connectionPragmas` before it is used.
 *
 * Statements of an open transaction go through its transaction context, which
 * is not part of the client and therefore unaffected. A statement issued on
 * the handle itself from inside the callback runs on the client's other
 * connection and meets the transaction's write lock: use the transaction
 * context for writes.
 * @param db - Drizzle libsql handle to adapt in place.
 * @param gate - Serialization shared by everything that uses the handle.
 * @param connectionPragmas - Statements that configure one connection.
 * @typeParam TTransaction - Transaction context type of the handle.
 */
export function bindLibsqlHandle<TTransaction extends NestedTransactionScope<TTransaction>>(
  db: LibsqlDatabase<TTransaction>,
  gate: HandleGate,
  connectionPragmas: readonly string[],
): void {
  const client = db.$client;
  // Configuring runs on the connection that was just opened and must not wait
  // for the gate it is part of, so it uses the unwrapped `execute`.
  const execute = client.execute.bind(client);
  const configure = async (): Promise<void> => {
    for (const pragma of connectionPragmas) await execute(pragma);
  };

  const openTransaction = client.transaction.bind(client);
  client.execute = gated(gate, execute);
  client.batch = gated(gate, client.batch.bind(client));
  client.migrate = gated(gate, client.migrate.bind(client));
  client.executeMultiple = gated(gate, client.executeMultiple.bind(client));
  client.transaction = gated(gate, async (mode) => {
    const opened = await openTransaction(mode);
    try {
      await configure();
    } catch (error) {
      // The write lock must not outlive a transaction nobody received. A
      // rollback that fails as well must not hide why configuring failed.
      try {
        await opened.rollback();
      } catch (rollbackError) {
        throw attachSecondaryFailure(error, rollbackError);
      }
      throw error;
    }
    return opened;
  });

  serializeLibsqlNestedTransactions(db);
  const transaction = db.transaction.bind(db);
  db.transaction = <T>(callback: (tx: TTransaction) => Promise<T>, config?: LibsqlTransactionConfig): Promise<T> =>
    gate.exclusive(() => transaction(callback, config));
}

/**
 * Make the nested transactions (savepoints) of every transaction a libsql
 * handle opens run one at a time.
 *
 * This is independent of the gate: drizzle opens savepoints with names derived
 * from the nesting depth, so two overlapping siblings of one transaction break
 * each other whether the handle is local or remote. Remote handles (no gate:
 * the server isolates their transactions) therefore get this binding alone;
 * {@link bindLibsqlHandle} includes it for local ones.
 * @param db - Drizzle libsql handle to adapt in place.
 * @typeParam TTransaction - Transaction context type of the handle.
 */
export function serializeLibsqlNestedTransactions<TTransaction extends NestedTransactionScope<TTransaction>>(
  db: Pick<LibsqlDatabase<TTransaction>, 'transaction'>,
): void {
  const transaction = db.transaction.bind(db);
  db.transaction = <T>(callback: (tx: TTransaction) => Promise<T>, config?: LibsqlTransactionConfig): Promise<T> =>
    transaction((tx) => {
      serializeNestedTransactions(tx);
      return callback(tx);
    }, config);
}
