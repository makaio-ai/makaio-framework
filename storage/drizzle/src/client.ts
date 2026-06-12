import { describeMissingStorageEngine } from './engine/hints';
import { getStorageEngine, resolveStorageEngineForUrl } from './engine/registry';
import type { MakaioDatabase, StorageDialect } from './types';

/**
 * Postgres-only connection pool tuning. Self-owned type — the published
 * declaration file never references `import('pg')` types.
 *
 * This is the typed engine-options seam: engine packages read it off
 * {@link DatabaseClientConfig.postgres} when creating Postgres clients.
 */
export interface PostgresClientOptions {
  /**
   * Maximum pooled connections. Defaults to 4 — sized for direct connections
   * to a small managed Postgres tier without an external connection pooler.
   */
  poolMax?: number;
}

/**
 * Configuration options for the database client.
 */
export interface DatabaseClientConfig {
  /**
   * Database URL. Driver selection is engine-based: the URL is resolved
   * against the storage engine registry. A registered engine that claims the
   * URL serves it (`postgres://` / `postgresql://` URLs are claimed by the
   * `@makaio/storage-pg` engine, which must be registered); every other URL
   * goes to the built-in default SQLite engine:
   * - `file:./path/to/db.db` — local SQLite file via the runtime SQLite driver.
   * - `libsql://host` — remote libSQL/Turso via `@libsql/client`.
   * - `http://localhost:8080` — local libSQL server via `@libsql/client`.
   * - `:memory:` — in-process in-memory SQLite database.
   *
   * Defaults to `'file:./makaio.db'`.
   */
  url?: string;

  /**
   * Authentication token for remote databases (Turso).
   * Not required for local file-based or in-memory databases.
   */
  authToken?: string;

  /**
   * Postgres-only connection pool tuning. Self-owned type — no `pg` type
   * dependency in the published declaration. Ignored for SQLite targets;
   * read by engine packages (`config.postgres`) when creating clients.
   */
  postgres?: PostgresClientOptions;
}

/**
 * Result of creating a database client.
 */
export interface DatabaseClient {
  /** The drizzle ORM instance */
  db: MakaioDatabase;
  /** Storage dialect served by this client. Matches the brand on {@link DatabaseClient.db}. */
  readonly dialect: StorageDialect;
  /**
   * Close the database connection. Safe to call multiple times.
   *
   * May return a promise when the underlying driver tears down asynchronously;
   * shutdown call sites must await the result — awaiting a synchronous `void`
   * is harmless.
   */
  close(): void | Promise<void>;
}

/**
 * Creates a drizzle ORM instance backed by the appropriate driver for the URL
 * and current runtime.
 *
 * **Driver selection is engine-based:** the URL is resolved against the
 * storage engine registry.
 * - A registered engine that claims the URL creates the client. `postgres://`
 *   / `postgresql://` URLs require the registered `@makaio/storage-pg` engine
 *   (which owns the node-postgres driver glue and declares `pg` as a regular
 *   dependency); without it they fail with an actionable install error
 *   instead of being misrouted to SQLite.
 * - **Every other URL** (including the `'file:./makaio.db'` default applied
 *   when `url` is omitted) — the registered default SQLite engine, which
 *   dispatches between the Bun-native `bun:sqlite` driver (local URLs under
 *   Bun) and `@libsql/client` (everything else) and applies local-database
 *   PRAGMAs (WAL journal mode, busy timeout, and foreign key enforcement for
 *   `file:` URLs; foreign key enforcement for `:memory:`).
 *
 * SEAM: This factory allows swapping the database backend by providing
 * different connection URLs (local file, Turso, libSQL server, Postgres) and
 * by registering additional storage engines that claim their own URL shapes.
 * @param config - Database configuration options
 * @returns Database client with drizzle ORM instance and close method
 * @example
 * ```typescript
 * import { createDatabaseClient } from '@makaio/storage-drizzle/client';
 *
 * // Local development with file-based SQLite
 * const { db, close } = await createDatabaseClient();
 *
 * // Production with Postgres
 * const { db, close } = await createDatabaseClient({
 *   url: process.env.DATABASE_URL, // postgres://user:pw@host:5432/db
 * });
 *
 * // Production with Turso
 * const { db, close } = await createDatabaseClient({
 *   url: process.env.TURSO_DATABASE_URL,
 *   authToken: process.env.TURSO_AUTH_TOKEN,
 * });
 *
 * // Close when done (close may resolve asynchronously — await is always safe)
 * await close();
 * ```
 */
export async function createDatabaseClient(config: DatabaseClientConfig = {}): Promise<DatabaseClient> {
  // An omitted URL falls through to the default SQLite engine, which applies
  // the 'file:./makaio.db' default — only explicit URLs are resolved against
  // the registry.
  if (config.url !== undefined) {
    const resolution = resolveStorageEngineForUrl(config.url);
    if (resolution.kind === 'missing-engine') {
      throw new Error(describeMissingStorageEngine(resolution.dialect, resolution.packageName));
    }
    if (resolution.kind === 'engine') {
      return resolution.engine.createClient(config);
    }
  }

  return getStorageEngine('sqlite').createClient(config);
}
