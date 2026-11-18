/**
 * Async transaction contract for the `bun:sqlite` driver.
 *
 * Drizzle's bun-sqlite dialect runs a transaction callback inside a
 * synchronous native transaction (or savepoint) that ends as soon as the
 * callback returns — for an async callback, at its first `await`. The shared
 * `MakaioDatabase` contract instead holds the transaction until the callback
 * settles. This module adapts a bun-sqlite handle to that contract:
 *
 * - **Atomicity:** the boundary is opened on the connection itself and closed
 *   only once the callback settled, at every nesting level.
 * - **Isolation:** the handle owns a single connection, so every statement is
 *   routed through the handle's {@link HandleGate}; a statement from outside
 *   an open transaction would otherwise run inside it. Statements are also
 *   prepared behind the gate, not only executed: preparation reads the schema,
 *   which an open transaction may have changed and could still roll back.
 * @packageDocumentation
 */
import type { HandleGate } from './handle-gate';
import { createSiblingQueue } from './nested-transactions';
import { attachSecondaryFailure } from './secondary-failure';

/** Native `bun:sqlite` statement surface drizzle's bun-sqlite session executes. */
export interface BunSqliteStatement {
  /**
   * Execute the statement, discarding rows.
   * @param params - Placeholder values.
   */
  run(...params: unknown[]): unknown;
  /**
   * Execute the statement and return all rows as objects.
   * @param params - Placeholder values.
   */
  all(...params: unknown[]): unknown;
  /**
   * Execute the statement and return the first row as an object.
   * @param params - Placeholder values.
   */
  get(...params: unknown[]): unknown;
  /**
   * Execute the statement and return raw row value arrays.
   * @param params - Placeholder values.
   */
  values(...params: unknown[]): unknown;
}

/** Native `bun:sqlite` connection surface the transaction boundaries are issued on. */
export interface BunSqliteConnection {
  /** Whether the connection currently has an open transaction. */
  readonly inTransaction: boolean;
  /**
   * Execute one SQL statement on the connection, discarding any rows.
   * @param statement - SQL text to execute.
   */
  run(statement: string): unknown;
  /**
   * Prepare a statement on the connection.
   * @param statement - SQL text to prepare.
   */
  prepare(statement: string): BunSqliteStatement;
}

/** Statement drizzle's bun-sqlite session prepares for every query it executes. */
interface BunSqlitePreparedQuery {
  /**
   * Execute the statement, discarding rows.
   * @param params - Placeholder values.
   */
  run(...params: unknown[]): unknown;
  /**
   * Execute the statement and return all mapped rows.
   * @param params - Placeholder values.
   */
  all(...params: unknown[]): unknown;
  /**
   * Execute the statement and return the first mapped row.
   * @param params - Placeholder values.
   */
  get(...params: unknown[]): unknown;
  /**
   * Execute the statement and return raw row value arrays.
   * @param params - Placeholder values.
   */
  values(...params: unknown[]): unknown;
}

/** Methods of {@link BunSqlitePreparedQuery} that execute against the connection. */
const STATEMENT_METHODS = ['run', 'all', 'get', 'values'] as const;

/**
 * Drizzle bun-sqlite session: the single point every statement of a handle —
 * and of every transaction context derived from it — is prepared through.
 */
interface BunSqliteSession {
  /**
   * Prepare a statement for execution on the connection.
   * @param args - Drizzle's prepare arguments, passed through unchanged.
   */
  prepareQuery(...args: unknown[]): BunSqlitePreparedQuery;
}

/** A drizzle bun-sqlite handle or transaction context that can open a nested transaction. */
export interface BunSqliteTransactionScope {
  /**
   * Run a callback inside a transaction (or, inside a transaction, a savepoint).
   * @param callback - Work to run with the transaction context.
   */
  transaction<T>(callback: (tx: BunSqliteTransactionScope) => Promise<T>): Promise<T>;
}

/** Drizzle bun-sqlite handle surface adapted by {@link bindBunSqliteTransactions}. */
export interface BunSqliteTransactionalDatabase extends BunSqliteTransactionScope {
  /** Session shared by the handle and every transaction context derived from it. */
  readonly session: BunSqliteSession;
}

/** SQL that opens, commits, and rolls back one transaction level. */
interface TransactionBoundary {
  readonly begin: string;
  readonly commit: string;
  readonly rollback: readonly string[];
}

/**
 * Boundary statements for a transaction nesting level.
 *
 * The outermost level takes the write lock up front (`BEGIN IMMEDIATE`), the
 * write mode `@libsql/client` opens transactions in on Node.js. The
 * `behavior` of drizzle's transaction configuration is not applied on either
 * driver: drizzle's libsql session ignores it, and the boundary here matches
 * that rather than honoring it on Bun alone. Nested levels
 * are savepoints; a rolled-back savepoint is released as well so the
 * savepoint stack matches the nesting again.
 * @param depth - Nesting level; `0` is the outermost transaction.
 * @returns Statements opening, committing, and rolling back that level.
 */
function transactionBoundary(depth: number): TransactionBoundary {
  if (depth === 0) return { begin: 'BEGIN IMMEDIATE', commit: 'COMMIT', rollback: ['ROLLBACK'] };
  const savepoint = `makaio_savepoint_${depth}`;
  return {
    begin: `SAVEPOINT ${savepoint}`,
    commit: `RELEASE SAVEPOINT ${savepoint}`,
    rollback: [`ROLLBACK TO SAVEPOINT ${savepoint}`, `RELEASE SAVEPOINT ${savepoint}`],
  };
}

/**
 * Run `body` between the boundary statements of one transaction level.
 *
 * Commits once `body` resolves and rolls back when it rejects or the commit
 * fails. The rollback is skipped when SQLite already ended the transaction on
 * its own; a failing rollback never replaces the original error: it is
 * attached to it (see {@link attachSecondaryFailure}).
 * @param connection - Connection the boundary statements are issued on.
 * @param boundary - Statements for this transaction level.
 * @param body - Work to run inside the boundary.
 * @returns Whatever `body` resolves to.
 * @typeParam T - Result type of the work.
 */
async function runWithinBoundary<T>(
  connection: BunSqliteConnection,
  boundary: TransactionBoundary,
  body: () => Promise<T>,
): Promise<T> {
  connection.run(boundary.begin);
  try {
    const result = await body();
    connection.run(boundary.commit);
    return result;
  } catch (error) {
    if (connection.inTransaction) {
      try {
        for (const statement of boundary.rollback) connection.run(statement);
      } catch (rollbackError) {
        throw attachSecondaryFailure(error, rollbackError);
      }
    }
    throw error;
  }
}

/**
 * Replace `scope.transaction` with one that holds its boundary open until the
 * async callback settled, and adapt every transaction context it hands out.
 *
 * Drizzle still creates the transaction context. Its synchronous wrapper runs
 * inside the boundary opened here as a savepoint (`bun:sqlite` turns a native
 * transaction on a connection that is already in one into a savepoint) and
 * releases it as soon as the callback returns, which leaves the boundary in
 * charge.
 * @param scope - Handle or transaction context whose `transaction` is replaced.
 * @param connection - Connection the boundary statements are issued on.
 * @param depth - Nesting level of the transactions `scope` opens.
 * @param enter - Admission of a transaction at this level to the connection: the
 *   handle's gate for the outermost level, the parent's sibling queue below it.
 */
function bindTransaction(
  scope: BunSqliteTransactionScope,
  connection: BunSqliteConnection,
  depth: number,
  enter: <T>(transaction: () => Promise<T>) => Promise<T>,
): void {
  const runNative = scope.transaction.bind(scope);
  const boundary = transactionBoundary(depth);
  scope.transaction = <T>(callback: (tx: BunSqliteTransactionScope) => Promise<T>): Promise<T> =>
    enter(() =>
      runWithinBoundary(connection, boundary, () =>
        runNative((tx) => {
          bindTransaction(tx, connection, depth + 1, createSiblingQueue());
          return callback(tx);
        }),
      ),
    );
}

/**
 * Defer the native preparation of every statement until it executes.
 *
 * Drizzle's bun-sqlite session prepares a statement while it builds the
 * prepared query, before anything could hold the statement back, and
 * preparation reads the schema: a table dropped by a transaction that is still
 * open and may roll back makes a statement from outside fail with "no such
 * table". Handing the session a statement that prepares on first execution
 * moves the preparation behind the gate together with the execution, which
 * {@link gateStatements} wraps.
 * @param connection - The handle's native connection, patched in place.
 */
function deferStatementPreparation(connection: BunSqliteConnection): void {
  const prepare = connection.prepare.bind(connection);
  connection.prepare = (text: string): BunSqliteStatement => {
    let statement: BunSqliteStatement | undefined;
    const native = (): BunSqliteStatement => (statement ??= prepare(text));
    // Every method of the native statement drizzle's session may call. Drizzle
    // 0.45.2 reads single rows through `values`, but `get` belongs to the same
    // native contract and a drizzle release may start using it: a statement
    // narrower than the native one would fail there with "get is not a
    // function".
    return {
      run: (...params) => native().run(...params),
      all: (...params) => native().all(...params),
      get: (...params) => native().get(...params),
      values: (...params) => native().values(...params),
    };
  };
}

/**
 * Wrap every statement the session prepares so it passes the gate.
 * @param session - Session shared by the handle and its transaction contexts.
 * @param gate - Gate of the session's connection.
 */
function gateStatements(session: BunSqliteSession, gate: HandleGate): void {
  const prepare = session.prepareQuery.bind(session);
  session.prepareQuery = (...args: unknown[]): BunSqlitePreparedQuery => {
    const query = prepare(...args);
    for (const method of STATEMENT_METHODS) {
      const execute = query[method].bind(query);
      query[method] = (...params: unknown[]): unknown => gate.run(() => execute(...params));
    }
    return query;
  };
}

/**
 * Make a drizzle bun-sqlite handle honor the async transaction contract of
 * `MakaioDatabase`.
 *
 * - `db.transaction()` and every nested `tx.transaction()` hold their
 *   transaction or savepoint open until the async callback settled: commit on
 *   fulfilment, roll back on rejection or when the commit fails.
 * - Every statement of the handle is prepared and executed behind `gate`, so
 *   statements that do not come from an open transaction's async context wait
 *   until it settled, as do further transactions.
 * @param db - Drizzle bun-sqlite handle to adapt in place.
 * @param connection - The handle's native connection.
 * @param gate - Serialization shared by everything that uses the handle.
 */
export function bindBunSqliteTransactions(
  db: BunSqliteTransactionalDatabase,
  connection: BunSqliteConnection,
  gate: HandleGate,
): void {
  deferStatementPreparation(connection);
  gateStatements(db.session, gate);
  bindTransaction(db, connection, 0, (transaction) => gate.exclusive(transaction));
}
