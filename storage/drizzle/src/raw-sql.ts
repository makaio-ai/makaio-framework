/**
 * Dialect-portable raw SQL executor.
 *
 * `MakaioDatabase` exposes the portable Drizzle query-builder surface; raw
 * statements (hand-written DDL, CTEs, FTS queries, transaction control) go
 * through the {@link RawSqlExecutor} attached to every factory-created handle.
 * The executor normalizes the driver-specific raw APIs (libsql's async
 * `ResultSet`, bun-sqlite's synchronous results) behind one contract; engine
 * packages implement the same contract over their own drivers (the Postgres
 * engine pins statements to a single pooled connection in `withSession`).
 * @packageDocumentation
 */
import type { SQL } from 'drizzle-orm';
import { affectedRowCount, type DrizzleWriteResult } from './result';
import { DATABASE_DIALECT, type MakaioDatabase, type StorageDialect } from './types';

/**
 * Statement surface available both standalone and inside a pinned session.
 */
export interface RawSqlSession {
  /**
   * Execute one statement. Affected-row count where the driver reports one
   * (drivers that report nothing yield `rowsAffected: 0`).
   * @param query - SQL statement to execute.
   * @returns Normalized write result.
   */
  run(query: SQL): Promise<{ rowsAffected: number }>;

  /**
   * Execute a query and return rows as column-name-keyed objects.
   * @param query - SQL query to execute.
   * @returns All result rows.
   * @typeParam TRow - Expected row shape keyed by column name.
   */
  all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]>;
}

/**
 * Dialect-portable raw SQL executor, attached to every handle by
 * `createDatabaseClient`. The ONLY sanctioned path for raw statements.
 *
 * INVARIANT: raw transaction control (BEGIN/COMMIT/ROLLBACK) may only ever be
 * issued inside {@link RawSqlExecutor.withSession}. On Postgres, standalone
 * `run` goes through the pool — raw BEGIN there would stripe statements
 * across connections.
 */
export interface RawSqlExecutor extends RawSqlSession {
  /** Storage dialect this executor speaks. Matches the handle's brand. */
  readonly dialect: StorageDialect;

  /**
   * Run `fn` with every statement pinned to one connection. Postgres: a
   * checked-out `pool.connect()` client that is always released — returned to
   * the pool on success, destroyed via `release(true)` when the callback
   * rejects so a poisoned connection (open or aborted transaction) never
   * re-enters the pool. SQLite: the single connection (trivial).
   * @param fn - Work to execute against the pinned session.
   * @returns The value resolved by `fn`.
   * @typeParam T - Result type produced by the session callback.
   */
  withSession<T>(fn: (session: RawSqlSession) => Promise<T>): Promise<T>;
}

/**
 * Brand key under which `createDatabaseClient` attaches the executor to a
 * handle. Declared via `Symbol.for` so the attachment survives duplicated
 * module instances (a bundled dist copy and a workspace copy of this package
 * resolve the same symbol through the global symbol registry).
 */
export const RAW_SQL_EXECUTOR: unique symbol = Symbol.for('makaio.storage.rawSqlExecutor');

/**
 * Internal view of a database handle that may carry an attached executor.
 * The symbol is intentionally absent from the public `MakaioDatabase` type —
 * consumers resolve the executor through {@link getRawSqlExecutor}.
 */
interface RawSqlExecutorCarrier {
  readonly [RAW_SQL_EXECUTOR]?: RawSqlExecutor;
}

/**
 * Attach the storage-dialect brand and the raw SQL executor to a drizzle
 * database instance.
 *
 * Both properties are non-enumerable so they never leak through spreads or
 * property enumeration, and non-writable/non-configurable so a handle's
 * dialect and executor cannot change after creation (re-branding throws).
 * Every branded handle carries an executor — `getRawSqlExecutor` relies on
 * this invariant, so the executor's dialect must match the brand.
 * @param db - Drizzle database instance to brand.
 * @param dialect - Storage dialect served by the instance.
 * @param executor - Raw SQL executor for the instance's connection(s).
 * @returns The same instance, branded.
 */
export function brandDatabase<TDb extends object>(db: TDb, dialect: StorageDialect, executor: RawSqlExecutor): TDb {
  if (executor.dialect !== dialect) {
    throw new Error(
      `brandDatabase: executor dialect '${executor.dialect}' does not match the brand dialect '${dialect}'`,
    );
  }
  Object.defineProperty(db, DATABASE_DIALECT, {
    value: dialect,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(db, RAW_SQL_EXECUTOR, {
    value: executor,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return db;
}

/**
 * Structural surface of the native SQLite drivers' raw statement API.
 *
 * Both `LibSQLDatabase` (async `ResultSet`) and `BunSQLiteDatabase`
 * (synchronous results) satisfy this shape, which is all the SQLite executor
 * needs to delegate.
 */
export interface SqliteRawDatabase {
  /**
   * Execute one statement on the native driver.
   * @param query - SQL statement to execute.
   * @returns Driver-specific result (awaited and normalized by the executor).
   */
  run(query: SQL): unknown;

  /**
   * Execute a query on the native driver and return all rows.
   * @param query - SQL query to execute.
   * @returns Rows, synchronously (bun-sqlite) or as a promise (libsql).
   * @typeParam TRow - Expected row shape keyed by column name.
   */
  all<TRow>(query: SQL): TRow[] | Promise<TRow[]>;
}

/**
 * Normalize a driver-specific raw `run` result to an affected-row count.
 * @param result - Whatever the native driver returned (libsql `ResultSet`,
 *   bun-sqlite's synchronous result, or `undefined`).
 * @returns Affected-row count, `0` when the driver reports none.
 */
function toRowsAffected(result: unknown): number {
  if (typeof result !== 'object' || result === null) {
    return 0;
  }
  return affectedRowCount(result as DrizzleWriteResult);
}

/**
 * Create a {@link RawSqlExecutor} over a native SQLite driver handle.
 *
 * SQLite has a single connection, so `withSession` is trivial: the standalone
 * statement surface and the pinned session are the same connection.
 * @param native - Concrete driver handle exposing the raw `run`/`all` API.
 * @returns Executor delegating to the native driver.
 */
export function createSqliteRawSqlExecutor(native: SqliteRawDatabase): RawSqlExecutor {
  const session: RawSqlSession = {
    async run(query: SQL): Promise<{ rowsAffected: number }> {
      // Awaiting tolerates both libsql's promise and bun-sqlite's sync result.
      const result: unknown = await native.run(query);
      return { rowsAffected: toRowsAffected(result) };
    },
    async all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
      return await native.all<TRow>(query);
    },
  };

  return {
    dialect: 'sqlite',
    run: session.run,
    all: session.all,
    async withSession<T>(fn: (pinned: RawSqlSession) => Promise<T>): Promise<T> {
      return fn(session);
    },
  };
}

/**
 * Returns `true` when the handle exposes the native SQLite raw API directly.
 * @param db - Database handle to probe.
 * @returns Whether a SQLite executor can be synthesized over the handle.
 */
function hasNativeRawApi(db: object): db is SqliteRawDatabase {
  const candidate = db as Partial<Record<'run' | 'all', unknown>>;
  return typeof candidate.run === 'function' && typeof candidate.all === 'function';
}

/**
 * Resolve the raw SQL executor for a database handle.
 *
 * Factory-created handles return the executor attached by
 * `createDatabaseClient`. Unbranded handles that expose the native SQLite
 * `run`/`all` API (hand-rolled test clients built directly on
 * `drizzle-orm/libsql` or `drizzle-orm/bun-sqlite`) get a synthesized SQLite
 * executor — mirroring the unbranded→`'sqlite'` dialect default.
 * @param db - Database handle to resolve the executor for.
 * @returns The handle's raw SQL executor.
 * @throws Error when the handle carries no executor and exposes no native
 *   SQLite raw API — create handles with `createDatabaseClient` instead.
 */
export function getRawSqlExecutor(db: MakaioDatabase): RawSqlExecutor {
  const attached = (db as RawSqlExecutorCarrier)[RAW_SQL_EXECUTOR];
  if (attached !== undefined) {
    return attached;
  }
  if (hasNativeRawApi(db)) {
    return createSqliteRawSqlExecutor(db);
  }
  throw new Error(
    'getRawSqlExecutor: database handle carries no raw SQL executor and exposes no native SQLite run/all API. ' +
      'Create handles with createDatabaseClient() from @makaio/storage-drizzle/client, which attaches the executor.',
  );
}
