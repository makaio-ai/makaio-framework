/**
 * SQLite client creation for the built-in engine.
 *
 * Owns the runtime driver dispatch (`bun:sqlite` under Bun for local URLs,
 * `@libsql/client` everywhere else) and the connection PRAGMAs applied to
 * local databases.
 * @packageDocumentation
 */
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { isBunRuntime } from '@makaio/utils';
import type { DatabaseClient, DatabaseClientConfig } from '../../client';
import { importRuntimeModule } from '../../import-runtime-module';
import { brandDatabase, createSqliteRawSqlExecutor, type SqliteRawDatabase } from '../../raw-sql';
import type { MakaioDatabase } from '../../types';

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

/**
 * Creates a SQLite database client backed by the appropriate driver for the
 * URL and current runtime.
 *
 * **Driver selection:**
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
 * @param config - Database configuration options. `url` defaults to
 *   `'file:./makaio.db'`.
 * @returns Database client with drizzle ORM instance and close method.
 */
export async function createSqliteClient(config: DatabaseClientConfig): Promise<DatabaseClient> {
  const { url = 'file:./makaio.db', authToken } = config;

  if (isBunRuntime() && isLocalDatabase(url)) {
    return createBunClient(url);
  }

  return createLibsqlClient(url, authToken);
}
