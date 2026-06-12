import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { isBunRuntime } from '@makaio/utils';
import {
  attachPgPoolErrorLogger,
  createPostgresRawSqlExecutor,
  createSqliteRawSqlExecutor,
  RAW_SQL_EXECUTOR,
  type PostgresPoolLike,
  type RawSqlExecutor,
  type SqliteRawDatabase,
} from './raw-sql';
import { DATABASE_DIALECT, type MakaioDatabase, type StorageDialect } from './types';

/**
 * Postgres-only connection pool tuning. Self-owned type — the published
 * declaration file never references `import('pg')` types.
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
   * Database URL. Driver selection follows this precedence:
   * - `postgres://` or `postgresql://` — node-postgres driver over a `pg` Pool
   *   (consumer-provided `pg` package).
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
   * dependency in the published declaration. Ignored for SQLite targets.
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
 * URL pattern that selects the Postgres backend.
 *
 * Both `postgres://` and `postgresql://` schemes are accepted, case-insensitively.
 * The Postgres branch is tested before the Bun branch so a pure-JS `pg` pool
 * works identically under both Node.js and Bun runtimes.
 */
const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\//i;

/**
 * Returns `true` when a database URL selects the Postgres backend.
 *
 * Single source of truth for the Postgres dispatch rule: runtime hosts that
 * discriminate connection targets before calling {@link createDatabaseClient}
 * consume this predicate so their notion of "a Postgres URL" can never drift
 * from the driver selection performed here.
 * @param url - Database URL to test.
 * @returns Whether the URL selects the Postgres backend.
 */
export function isPostgresUrl(url: string): boolean {
  return POSTGRES_URL_PATTERN.test(url);
}

/**
 * Default maximum pool size for Postgres connections.
 *
 * Sized for direct connections to a small managed Postgres tier without an
 * external connection pooler. Callers that need a different limit pass
 * `postgres.poolMax` in {@link DatabaseClientConfig}.
 */
const DEFAULT_PG_POOL_MAX = 4;

/**
 * Creates a drizzle ORM instance backed by the appropriate driver for the URL
 * and current runtime.
 *
 * **Driver selection:**
 * - **`postgres://` / `postgresql://`** — node-postgres driver over a `pg` Pool.
 *   The `pg` package is consumer-provided; install it in the host application to
 *   use Postgres URLs. This branch runs before the Bun check so `pg` works under
 *   both Node.js and Bun.
 * - **Bun + local URL** (`file:` or `:memory:`) — uses the built-in `bun:sqlite`
 *   driver via `drizzle-orm/bun-sqlite`. The module is loaded dynamically so
 *   this file is safe to import under Node.js.
 * - **Bun + remote URL** (`libsql:`, `http:`, `https:`, …) — stays on
 *   `@libsql/client` via `drizzle-orm/libsql`; `bun:sqlite` cannot handle
 *   remote connections.
 * - **Node.js** — always uses `@libsql/client` via `drizzle-orm/libsql`.
 *
 * For local SQLite databases, automatically enables:
 * - `file:` URLs: WAL journal mode, 5-second busy timeout, and foreign key enforcement
 * - `:memory:`: foreign key enforcement only
 *
 * SEAM: This factory allows swapping the database backend by providing
 * different connection URLs (local file, Turso, libSQL server, Postgres).
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
  const { url = 'file:./makaio.db', authToken } = config;

  if (isPostgresUrl(url)) {
    return createNodePgClient(url, config.postgres);
  }

  if (isBunRuntime() && isLocalDatabase(url)) {
    return createBunClient(url);
  }

  return createLibsqlClient(url, authToken);
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
 * Returns `true` when the URL refers to a local database (file or in-memory).
 *
 * File-backed local databases support WAL journal mode plus file-level SQLite
 * contention tuning. In-memory databases only receive foreign key enforcement.
 * Remote libSQL/Turso connections must not receive these PRAGMAs.
 * @param url - Database URL string.
 * @returns Whether the URL is a local SQLite database.
 */
function isLocalDatabase(url: string): boolean {
  return url.startsWith('file:') || url === ':memory:';
}

/**
 * PRAGMAs applied to file-backed local SQLite databases.
 *
 * - `journal_mode = WAL` improves concurrent read/write throughput.
 * - `busy_timeout = 5000` serializes concurrent writers instead of failing
 *   immediately with SQLITE_BUSY.
 * - `foreign_keys = ON` enforces referential integrity at the SQLite level.
 */
const FILE_PRAGMAS = ['PRAGMA journal_mode = WAL', 'PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON'] as const;

/**
 * PRAGMAs applied to in-memory SQLite databases.
 *
 * - `foreign_keys = ON` enforces referential integrity at the SQLite level.
 *
 * Remote libSQL/Turso connections must not receive these PRAGMAs.
 */
const MEMORY_PRAGMAS = ['PRAGMA foreign_keys = ON'] as const;

/**
 * Imports a module whose specifier must stay opaque to bundlers.
 *
 * `pg`, `drizzle-orm/node-postgres`, `bun:sqlite`, and
 * `drizzle-orm/bun-sqlite` are optional or runtime-gated modules that may only
 * be resolved when their driver branch is actually reached at runtime. A
 * literal `import('pg')` — or a `const id = 'pg'; import(id)` indirection,
 * which minifiers constant-fold back into the literal form — lets bundlers
 * (Vite, esbuild, rolldown) resolve the specifier at bundle time and fail or
 * inline it. Routing the specifier through a function parameter keeps the
 * emitted call a fully dynamic `import(specifier)` that bundlers treat as
 * runtime-only, in source and in minified distribution output alike.
 * @param specifier - Bare module specifier to import at runtime.
 * @typeParam TModule - Structural surface of the module the caller consumes.
 * @returns Promise of the loaded module, typed by the caller.
 */
function importRuntimeModule<TModule>(specifier: string): Promise<TModule> {
  return import(/* @vite-ignore */ specifier) as Promise<TModule>;
}

/** Minimal structural surface of a `bun:sqlite` database instance used here. */
interface BunSqliteDatabaseLike {
  close(): void;
}

/** Structural surface of the `bun:sqlite` module used by {@link createBunClient}. */
interface BunSqliteModule {
  Database: new (filename: string) => BunSqliteDatabaseLike;
}

/** Structural surface of the `drizzle-orm/bun-sqlite` module used by {@link createBunClient}. */
interface BunSqliteDrizzleModule {
  drizzle: (client: BunSqliteDatabaseLike) => SqliteRawDatabase;
}

/** Structural surface of the consumer-provided `pg` module used by {@link createNodePgClient}. */
interface PgModule {
  default: { Pool: new (config: { connectionString: string; max: number }) => PostgresPoolLike };
}

/** Structural surface of the `drizzle-orm/node-postgres` module used by {@link createNodePgClient}. */
interface NodePgDrizzleModule {
  drizzle: (pool: PostgresPoolLike) => object;
}

/**
 * Creates a database client backed by the Bun-native `bun:sqlite` driver.
 *
 * Uses a dynamic `import()` so the `bun:sqlite` module is never evaluated
 * under Node.js, where it does not exist.
 *
 * PRAGMAs are applied synchronously because the bun-sqlite dialect is
 * synchronous: `db.run()` executes immediately and returns `void`.
 * @param url - Database URL (`file:` path or `:memory:`).
 * @returns Database client with drizzle ORM instance and close method.
 */
async function createBunClient(url: string): Promise<DatabaseClient> {
  // These modules only exist under Bun and are never evaluated under Node.js;
  // importRuntimeModule keeps the specifiers opaque to bundlers.
  const { Database } = await importRuntimeModule<BunSqliteModule>('bun:sqlite');
  const { drizzle } = await importRuntimeModule<BunSqliteDrizzleModule>('drizzle-orm/bun-sqlite');

  // bun:sqlite expects a raw file path or ':memory:', not a 'file:' URL.
  // fileURLToPath handles all RFC 3986 forms: file:./rel, file:/abs, file:///abs.
  const filePath =
    url === ':memory:' ? ':memory:' : url.startsWith('file://') ? fileURLToPath(url) : url.replace(/^file:/, '');
  const sqlite = new Database(filePath);
  const db = drizzle(sqlite);

  for (const pragma of getLocalPragmas(url)) {
    db.run(sql.raw(pragma));
  }

  brandDatabase(db, 'sqlite', createSqliteRawSqlExecutor(db));

  // BunSQLiteDatabase and LibSQLDatabase share the same query-builder surface
  // (select, insert, update, delete, run, all, etc.) with compatible call
  // signatures.  The only divergence is that bun-sqlite methods are sync while
  // libsql methods are async; `await syncValue` is a JavaScript no-op, so all
  // existing consumer `await db.*()` call sites work correctly under both
  // drivers.  The cast bridges two structurally-similar-but-not-identical types
  // at this single seam point so that the rest of the codebase sees the shared
  // async-compatible contract exposed by `MakaioDatabase`.
  // Validated against drizzle-orm 0.45.2.
  let closed = false;
  return {
    db: db as unknown as MakaioDatabase,
    dialect: 'sqlite',
    close: () => {
      if (closed) return;
      closed = true;
      sqlite.close();
    },
  };
}

/**
 * Creates a database client backed by the libsql driver for Node.js.
 *
 * Uses Drizzle 0.44+ built-in connection management — Drizzle creates and
 * manages the underlying `@libsql/client` internally.
 * @param url - Database URL (libSQL connection string or `:memory:`).
 * @param authToken - Optional auth token for Turso remote databases.
 * @returns Database client with drizzle ORM instance and close method.
 */
async function createLibsqlClient(url: string, authToken: string | undefined): Promise<DatabaseClient> {
  const { drizzle: libsqlDrizzle } = await import('drizzle-orm/libsql');
  const db = libsqlDrizzle({
    connection: {
      url,
      authToken,
    },
  });

  if (isLocalDatabase(url)) {
    for (const pragma of getLocalPragmas(url)) {
      await db.run(sql.raw(pragma));
    }
  }

  brandDatabase(db, 'sqlite', createSqliteRawSqlExecutor(db));
  let closed = false;
  return {
    db,
    dialect: 'sqlite',
    close: () => {
      if (closed) return;
      closed = true;
      db.$client.close();
    },
  };
}

/**
 * Creates a database client backed by the node-postgres (`pg`) driver.
 *
 * Both `'pg'` and `'drizzle-orm/node-postgres'` are loaded through
 * {@link importRuntimeModule} so neither is resolved at bundle time. The `pg`
 * package is consumer-provided — call sites that reach a `postgres://` URL
 * must have `pg` installed in the host application.
 * @param url - Postgres connection URL (`postgres://` or `postgresql://`).
 * @param options - Optional pool tuning options.
 * @returns Database client with drizzle ORM instance and async close method.
 */
async function createNodePgClient(url: string, options: PostgresClientOptions | undefined): Promise<DatabaseClient> {
  // 'pg' is consumer-provided (documented in the README, deliberately never
  // declared in this package's dependencies or peer dependencies) and
  // 'drizzle-orm/node-postgres' imports it at module load, so neither may be
  // resolved unless a postgres:// URL is actually used; importRuntimeModule
  // keeps both specifiers opaque to bundlers.
  let pg: PgModule['default'];
  let drizzlePg: NodePgDrizzleModule['drizzle'];
  try {
    ({ default: pg } = await importRuntimeModule<PgModule>('pg'));
    ({ drizzle: drizzlePg } = await importRuntimeModule<NodePgDrizzleModule>('drizzle-orm/node-postgres'));
  } catch (error) {
    throw new Error(
      'createDatabaseClient: the Postgres backend could not load its runtime modules ' +
        "('pg' and 'drizzle-orm/node-postgres'). Install the consumer-provided 'pg' package " +
        'in the host application to use postgres:// database URLs.',
      { cause: error },
    );
  }

  const pool = new pg.Pool({ connectionString: url, max: options?.poolMax ?? DEFAULT_PG_POOL_MAX });
  // node-postgres re-emits idle-connection failures on the pool itself; an
  // unhandled 'error' event there would crash the host process, so the pool
  // always gets the framework's logging listener.
  attachPgPoolErrorLogger(pool);
  const db = drizzlePg(pool);
  brandDatabase(db, 'postgres', createPostgresRawSqlExecutor(pool));

  // NodePgDatabase and LibSQLDatabase share the portable query-builder surface
  // (select, insert, update, delete, transaction) with compatible call
  // signatures.  MakaioDatabase already excludes every libsql-only member
  // (run, all, get, values, batch, $client, resultKind), so the remaining
  // contract is dialect-portable.  At runtime the handle is a real Postgres
  // database, so drizzle emits dialect-correct SQL — the bridge is types-only,
  // the same documented honesty model as the Bun cast.
  // Validated against drizzle-orm 0.45.2.
  let closed = false;
  return {
    db: db as unknown as MakaioDatabase,
    dialect: 'postgres',
    close: async () => {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}

/**
 * Returns `true` when the URL refers to a file-backed database.
 * @param url - Database URL string.
 * @returns Whether the URL resolves to a `file:` database.
 */
function isFileDatabase(url: string): boolean {
  return url.startsWith('file:');
}

/**
 * Returns the PRAGMA sequence for a local database URL.
 * @param url - Database URL string.
 * @returns PRAGMAs to apply for the requested local database flavor.
 */
function getLocalPragmas(url: string): readonly string[] {
  return isFileDatabase(url) ? FILE_PRAGMAS : MEMORY_PRAGMAS;
}
