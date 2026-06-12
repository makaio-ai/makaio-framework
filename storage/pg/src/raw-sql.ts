/**
 * Postgres raw SQL executor.
 *
 * Implements the `RawSqlExecutor` contract of `@makaio/storage-drizzle` over a
 * node-postgres pool: standalone statements go through the pool, `withSession`
 * pins every statement of a callback to a single checked-out connection. The
 * pool surface is self-owned structural typing so the published declaration
 * file never references `import('pg')`.
 * @packageDocumentation
 */
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { RawSqlExecutor, RawSqlSession } from '@makaio/storage-drizzle';

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
      '[makaio:storage-pg] Postgres pool: an idle pooled connection failed ' +
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
