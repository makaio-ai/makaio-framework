/**
 * Dialect-portable raw SQL executor.
 *
 * `MakaioDatabase` exposes the portable Drizzle query-builder surface; raw
 * statements (hand-written DDL, CTEs, FTS queries, transaction control) go
 * through the {@link RawSqlExecutor} attached to every factory-created handle.
 * The executor normalizes the driver-specific raw APIs (libsql's async
 * `ResultSet`, bun-sqlite's synchronous results) behind one contract and gives
 * Postgres a place to pin statements to a single pooled connection.
 * @packageDocumentation
 */
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { affectedRowCount, type DrizzleWriteResult } from './result';
import type { MakaioDatabase, StorageDialect } from './types';

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

// ---------------------------------------------------------------------------
// Postgres structural types — self-owned; never reference import('pg').
// These mirror the public API surface of the `pg` package without introducing
// a type dependency that would leak into the published declaration file.
// ---------------------------------------------------------------------------

/**
 * Structural result shape of a node-postgres `query()` call.
 *
 * Self-owned so the published declaration file never references `import('pg')`.
 */
export interface PostgresQueryResultLike {
  /** Result rows, each keyed by column name. */
  rows: Array<Record<string, unknown>>;
  /** Number of rows affected (INSERT/UPDATE/DELETE), or `null` when not applicable. */
  rowCount: number | null;
}

/**
 * Structural surface shared by a `pg` Pool and a checked-out pool client.
 *
 * Self-owned so the published declaration file never references `import('pg')`.
 */
export interface PostgresQueryableLike {
  /**
   * Execute a parameterized SQL statement.
   * @param text - SQL text with `$1`-style positional placeholders.
   * @param params - Positional parameter values corresponding to the placeholders.
   * @returns Query result with rows and affected-row count.
   */
  query(text: string, params: unknown[]): Promise<PostgresQueryResultLike>;
}

/**
 * Structural surface of a checked-out `pg` pool client.
 *
 * Self-owned so the published declaration file never references `import('pg')`.
 */
export interface PostgresPoolClientLike extends PostgresQueryableLike {
  /**
   * Return the connection to the pool.
   * @param destroy - When truthy, destroy the connection instead of returning it.
   *   Pass `true` after a failed callback to prevent a poisoned connection from
   *   re-entering the pool.
   */
  release(destroy?: boolean): void;
}

/**
 * Structural surface of a `pg` Pool.
 *
 * Self-owned so the published declaration file never references `import('pg')`.
 */
export interface PostgresPoolLike extends PostgresQueryableLike {
  /**
   * Check out a dedicated connection from the pool.
   * @returns A pool client pinned to one server connection.
   */
  connect(): Promise<PostgresPoolClientLike>;

  /**
   * Drain the pool and close all connections.
   * Called once during client shutdown.
   * @returns Promise that resolves when the pool has fully closed.
   */
  end(): Promise<void>;

  /**
   * Subscribe to pool events. Only the `'error'` event is part of this
   * structural surface: node-postgres re-emits failures of idle pooled
   * connections on the pool's own event emitter, and an `'error'` event
   * without a listener escalates to an uncaught exception that terminates
   * the process.
   * @param event - Pool event name; only `'error'` is consumed here.
   * @param listener - Listener invoked with the emitted error.
   */
  on(event: 'error', listener: (error: Error) => void): void;
}

/**
 * Attach the idle-connection error listener to a `pg` Pool.
 *
 * When the backend goes down or a network partition occurs, node-postgres
 * emits an error for every idle pooled connection on the pool itself; without
 * a listener that `'error'` event becomes an uncaught exception and kills the
 * host process. A dropped idle connection is routine (server restart, network
 * blip) and the pool replaces it on the next checkout, so the listener logs
 * the failure and lets the process continue.
 * @param pool - Pool to guard against unhandled idle-connection errors.
 */
export function attachPgPoolErrorLogger(pool: Pick<PostgresPoolLike, 'on'>): void {
  pool.on('error', (error) => {
    console.error(
      '[makaio:storage-drizzle] Postgres pool: an idle pooled connection failed ' +
        '(backend restart or network drop); the pool replaces it on next use.',
      error,
    );
  });
}

/**
 * Create a {@link RawSqlExecutor} over a `pg` Pool.
 *
 * Standalone `run` and `all` calls go through the pool directly. `withSession`
 * checks out a single `pool.connect()` client for the duration of the callback.
 * The client is always released: returned to the pool on success, destroyed via
 * `release(true)` when the callback rejects so a poisoned connection (open or
 * aborted transaction) never re-enters the pool.
 *
 * INVARIANT: raw transaction control (BEGIN/COMMIT/ROLLBACK) may only ever be
 * issued inside {@link RawSqlExecutor.withSession}. On Postgres, standalone
 * `run` goes through the pool — raw BEGIN there would stripe statements across
 * connections as the pool re-assigns them per call.
 *
 * SQL objects are serialized using `PgDialect.sqlToQuery`, which produces
 * `$1`-style positional placeholders compatible with the `pg` driver.
 * @param pool - Postgres pool to execute statements against.
 * @returns Executor delegating to the pool.
 */
export function createPostgresRawSqlExecutor(pool: PostgresPoolLike): RawSqlExecutor {
  const pgDialect = new PgDialect();

  const sessionOver = (target: PostgresQueryableLike): RawSqlSession => ({
    async run(query: SQL): Promise<{ rowsAffected: number }> {
      const { sql: text, params } = pgDialect.sqlToQuery(query);
      const result = await target.query(text, params);
      return { rowsAffected: result.rowCount ?? 0 };
    },
    async all<TRow extends Record<string, unknown>>(query: SQL): Promise<TRow[]> {
      const { sql: text, params } = pgDialect.sqlToQuery(query);
      const result = await target.query(text, params);
      // result.rows is typed as Array<Record<string, unknown>> — a plain related-type
      // assertion narrowing to the caller-supplied row shape is sufficient here.
      return result.rows as TRow[];
    },
  });

  const standalone = sessionOver(pool);

  return {
    dialect: 'postgres',
    run: standalone.run,
    all: standalone.all,
    async withSession<T>(fn: (pinned: RawSqlSession) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        const result = await fn(sessionOver(client));
        client.release();
        return result;
      } catch (error) {
        // Destroy instead of pooling: the failed callback may have left an open
        // or aborted transaction on the pinned connection.
        client.release(true);
        throw error;
      }
    },
  };
}
