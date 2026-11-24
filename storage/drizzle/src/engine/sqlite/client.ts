/**
 * SQLite client creation for the built-in engine.
 *
 * Owns the runtime driver dispatch (`bun:sqlite` under Bun for local URLs,
 * `@libsql/client` everywhere else), the PRAGMAs applied to local databases,
 * and binding both drivers to the per-handle serialization contract of
 * `MakaioDatabase` (see {@link HandleGate}).
 * @packageDocumentation
 */
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { isBunRuntime } from '@makaio/utils';
import type { DatabaseClient, DatabaseClientConfig } from '../../client';
import { bindDatabaseSignals, type DatabaseSignals } from '../../database-signals';
import { releaseHostDatabaseWake } from '../../host-database-wake';
import { importRuntimeModule } from '../../import-runtime-module';
import { brandDatabase, createSqliteRawSqlExecutor, type SqliteRawDatabase } from '../../raw-sql';
import type { MakaioDatabase } from '../../types';
import {
  bindBunSqliteTransactions,
  type BunSqliteConnection,
  type BunSqliteTransactionalDatabase,
} from './bun-transaction';
import { createGatedClose } from './gated-close';
import { HandleGate } from './handle-gate';
import { bindLibsqlHandle, serializeLibsqlNestedTransactions } from './libsql-handle';
import { attachSecondaryFailure } from './secondary-failure';

/**
 * Returns `true` when the URL names an in-memory SQLite database.
 *
 * Recognizes every spelling `@libsql/client` resolves to one: `:memory:`, the
 * `file::memory:` it normalizes that to (with or without query parameters),
 * and `file:` URLs carrying `mode=memory`. Spelling must not decide the
 * classification: `file::memory:` starts with `file:` but names no file.
 * @param url - Database URL string.
 * @returns Whether the URL names an in-memory database.
 */
function isInMemoryUrl(url: string): boolean {
  if (url === ':memory:') return true;
  if (!url.startsWith('file:')) return false;
  const queryStart = url.indexOf('?');
  const target = url.slice('file:'.length, queryStart === -1 ? undefined : queryStart);
  const query = new URLSearchParams(queryStart === -1 ? '' : url.slice(queryStart + 1));
  return target === ':memory:' || query.get('mode') === 'memory';
}

/**
 * Returns `true` when the URL refers to a local database (file or in-memory).
 *
 * File-backed local databases support WAL journal mode plus file-level SQLite
 * contention tuning. In-memory databases (only served by `bun:sqlite`, see
 * {@link createLibsqlClient}) only receive foreign key enforcement. Remote
 * libSQL/Turso connections must not receive these PRAGMAs.
 * @param url - Database URL string.
 * @returns Whether the URL is a local SQLite database.
 */
function isLocalDatabase(url: string): boolean {
  return url.startsWith('file:') || url === ':memory:';
}

/**
 * PRAGMAs that configure a file-backed database itself.
 *
 * - `journal_mode = WAL` improves concurrent read/write throughput. The mode is
 *   stored in the database file, so it is applied once per handle.
 */
const FILE_DATABASE_PRAGMAS = ['PRAGMA journal_mode = WAL'] as const;

/**
 * PRAGMAs applied to every connection of a file-backed local SQLite handle.
 *
 * - `busy_timeout = 5000` waits for a competing writer instead of failing
 *   immediately with SQLITE_BUSY.
 * - `foreign_keys = ON` enforces referential integrity at the SQLite level.
 *
 * These are per connection: a driver that opens further connections for a
 * handle (libsql does after every transaction) must apply them to each.
 */
const FILE_CONNECTION_PRAGMAS = ['PRAGMA busy_timeout = 5000', 'PRAGMA foreign_keys = ON'] as const;

/**
 * PRAGMAs applied to the connection of an in-memory SQLite handle (served by
 * `bun:sqlite` only, which keeps exactly one connection).
 *
 * - `foreign_keys = ON` enforces referential integrity at the SQLite level.
 *
 * Remote libSQL/Turso connections must not receive these PRAGMAs.
 */
const MEMORY_CONNECTION_PRAGMAS = ['PRAGMA foreign_keys = ON'] as const;

/** Minimal structural surface of a `bun:sqlite` database instance used here. */
interface BunSqliteDatabaseLike extends BunSqliteConnection {
  close(): void;
}

/** Structural surface of the `bun:sqlite` module used by {@link createBunClient}. */
interface BunSqliteModule {
  Database: new (filename: string) => BunSqliteDatabaseLike;
}

/** Structural surface of a drizzle bun-sqlite database used by {@link createBunClient}. */
interface BunSqliteDrizzleDatabase extends SqliteRawDatabase, BunSqliteTransactionalDatabase {}

/** Structural surface of the `drizzle-orm/bun-sqlite` module used by {@link createBunClient}. */
interface BunSqliteDrizzleModule {
  drizzle: (client: BunSqliteDatabaseLike) => BunSqliteDrizzleDatabase;
}

/**
 * Creates a database client backed by the Bun-native `bun:sqlite` driver.
 *
 * Uses a dynamic `import()` so the `bun:sqlite` module is never evaluated
 * under Node.js, where it does not exist.
 *
 * PRAGMAs are applied synchronously because the bun-sqlite dialect is
 * synchronous: `db.run()` executes immediately and returns `void`.
 * @param url - Database URL (`file:` path or an in-memory spelling).
 * @returns Database client with drizzle ORM instance and close method.
 */
async function createBunClient(url: string): Promise<DatabaseClient> {
  // These modules only exist under Bun and are never evaluated under Node.js;
  // importRuntimeModule keeps the specifiers opaque to bundlers.
  const { Database } = await importRuntimeModule<BunSqliteModule>('bun:sqlite');
  const { drizzle } = await importRuntimeModule<BunSqliteDrizzleModule>('drizzle-orm/bun-sqlite');

  // bun:sqlite expects a raw file path or ':memory:', not a 'file:' URL, and
  // would create a file named after an in-memory URL's query string.
  // fileURLToPath handles all RFC 3986 forms: file:./rel, file:/abs, file:///abs.
  const filePath = isInMemoryUrl(url)
    ? ':memory:'
    : url.startsWith('file://')
      ? fileURLToPath(url)
      : url.replace(/^file:/, '');
  const sqlite = new Database(filePath);
  const db = drizzle(sqlite);

  try {
    for (const pragma of getLocalPragmas(url)) {
      db.run(sql.raw(pragma));
    }
  } catch (error) {
    // A handle nobody received must not keep its connection (and the file) open.
    try {
      sqlite.close();
    } catch (closeError) {
      throw attachSecondaryFailure(error, closeError);
    }
    throw error;
  }

  const gate = new HandleGate();
  bindBunSqliteTransactions(db, sqlite, gate);
  brandDatabase(db, 'sqlite', createSqliteRawSqlExecutor(db, gate));

  // BunSQLiteDatabase and LibSQLDatabase share the same query-builder surface
  // (select, insert, update, delete, run, all, etc.) with compatible call
  // signatures.  The divergence is that bun-sqlite methods are sync while
  // libsql methods are async; `await syncValue` is a JavaScript no-op, so all
  // existing consumer `await db.*()` call sites work correctly under both
  // drivers.  Transactions are what a no-op await cannot bridge:
  // bindBunSqliteTransactions above holds them open across the callback's
  // awaits and the gate keeps other statements on the single connection out
  // of them.
  // The cast bridges two structurally-similar-but-not-identical types at this
  // single seam point so that the rest of the codebase sees the shared
  // async-compatible contract exposed by `MakaioDatabase`.
  // Validated against drizzle-orm 0.45.2.
  const signals = classifySqliteSignals(url);
  bindDatabaseSignals(db, signals);
  return {
    db: db as unknown as MakaioDatabase,
    dialect: 'sqlite',
    signals,
    // No listener connection or other per-client state was ever opened for a
    // 'none' signal capability, so close() has nothing of its own to tear down
    // beyond releasing the handle's wake dispatcher, if one was ever created.
    close: createGatedClose(gate, () => {
      releaseHostDatabaseWake(db);
      sqlite.close();
    }),
  };
}

/**
 * Creates a database client backed by the libsql driver for Node.js.
 *
 * Uses Drizzle 0.44+ built-in connection management — Drizzle creates and
 * manages the underlying `@libsql/client` internally.
 *
 * **In-memory URLs are rejected.** `@libsql/client` owns one connection, and
 * opening a transaction hands that connection to the transaction; the client
 * opens a new one for the next statement. For a file that is the same
 * database, for an in-memory URL it is a new, empty one, so everything written
 * before the first transaction is lost. A temporary database file gives every
 * connection the same database. `bun:sqlite` keeps one connection for the
 * handle's whole life and has no such handoff, so it accepts in-memory
 * databases (see {@link createBunClient}).
 * @param url - Database URL (libSQL connection string or `file:` path).
 * @param authToken - Optional auth token for Turso remote databases.
 * @returns Database client with drizzle ORM instance and close method.
 * @throws Error when the URL names an in-memory database.
 */
async function createLibsqlClient(url: string, authToken: string | undefined): Promise<DatabaseClient> {
  if (isInMemoryUrl(url)) {
    throw new Error(
      `In-memory SQLite URLs are not supported by the libsql driver (received '${url}'): libsql transactions ` +
        `take over the connection and the client continues on a new, empty one, so the in-memory database is ` +
        `lost after the first transaction. Use a temporary database file instead, for example ` +
        `'file:/path/to/temporary.db'. Only bun:sqlite, which keeps a single connection, serves in-memory databases.`,
    );
  }
  const { drizzle: libsqlDrizzle } = await import('drizzle-orm/libsql');
  const db = libsqlDrizzle({
    connection: {
      url,
      authToken,
    },
  });

  let localGate: HandleGate | undefined;
  if (isLocalDatabase(url)) {
    try {
      for (const pragma of getLocalPragmas(url)) {
        await db.run(sql.raw(pragma));
      }
    } catch (error) {
      // A handle nobody received must not keep its connection (and the file) open.
      try {
        db.$client.close();
      } catch (closeError) {
        throw attachSecondaryFailure(error, closeError);
      }
      throw error;
    }
    // libsql opens a new connection after every transaction: serialize the
    // handle's statements around it and configure each connection it opens.
    localGate = new HandleGate();
    bindLibsqlHandle(db, localGate, getConnectionPragmas(url));
  } else {
    // No gate for remote handles (the server isolates their transactions), but
    // the savepoints of one transaction stack on the client side all the same.
    serializeLibsqlNestedTransactions(db);
  }

  brandDatabase(db, 'sqlite', createSqliteRawSqlExecutor(db, localGate));
  const signals = classifySqliteSignals(url);
  bindDatabaseSignals(db, signals);
  return {
    db,
    dialect: 'sqlite',
    signals,
    // Only the connection the client holds right now: see the release note of
    // `libsql-handle.ts` for connections handed to earlier transactions.
    // No listener connection or other per-client state was ever opened for a
    // 'none' signal capability, so close() has nothing of its own to tear down
    // beyond releasing the handle's wake dispatcher, if one was ever created.
    close: createGatedClose(localGate, () => {
      releaseHostDatabaseWake(db);
      db.$client.close();
    }),
  };
}

/**
 * Returns `true` when the URL refers to a file-backed database.
 * @param url - Database URL string.
 * @returns Whether the URL resolves to a `file:` database that is not an in-memory spelling.
 */
function isFileDatabase(url: string): boolean {
  return url.startsWith('file:') && !isInMemoryUrl(url);
}

/**
 * Classifies a SQLite URL into its signal capability: every SQLite target
 * declares `{ kind: 'none' }`, naming why no cross-process wake is available.
 *
 * Reuses {@link isInMemoryUrl} and {@link isFileDatabase} — the same
 * predicates that already decide PRAGMA application — so the signal
 * classification can never disagree with them about what a URL names. Both
 * {@link createBunClient} and {@link createLibsqlClient} call this one
 * function; neither re-derives the classification with its own URL check.
 *
 * An in-memory URL reaching the libsql driver is rejected before this
 * function would be reached (see {@link createLibsqlClient}), so the
 * `'in-memory'` branch here is only ever produced for `bun:sqlite` handles.
 * @param url - Database URL string.
 * @returns The `{ kind: 'none' }` signal capability naming the reason.
 */
function classifySqliteSignals(url: string): DatabaseSignals {
  if (isInMemoryUrl(url)) {
    return { kind: 'none', reason: 'in-memory' };
  }
  if (isFileDatabase(url)) {
    return { kind: 'none', reason: 'sqlite-file' };
  }
  return { kind: 'none', reason: 'remote-libsql' };
}

/**
 * Returns the PRAGMAs that configure the local database itself, once per handle.
 * @param url - Database URL string.
 * @returns PRAGMAs to apply when the handle is created.
 */
function getDatabasePragmas(url: string): readonly string[] {
  return isFileDatabase(url) ? FILE_DATABASE_PRAGMAS : [];
}

/**
 * Returns the PRAGMA sequence applied when a local handle is created.
 * @param url - Database URL string.
 * @returns Database-level PRAGMAs followed by the connection-level ones.
 */
function getLocalPragmas(url: string): readonly string[] {
  return [...getDatabasePragmas(url), ...getConnectionPragmas(url)];
}

/**
 * Returns the PRAGMAs every connection of a local handle must carry.
 * @param url - Database URL string.
 * @returns PRAGMAs to apply to each connection the handle opens.
 */
function getConnectionPragmas(url: string): readonly string[] {
  return isFileDatabase(url) ? FILE_CONNECTION_PRAGMAS : MEMORY_CONNECTION_PRAGMAS;
}

/**
 * Creates a SQLite database client backed by the appropriate driver for the
 * URL and current runtime.
 *
 * **Driver selection:**
 * - **Bun + local URL** (`file:` or an in-memory URL) — uses the built-in
 *   `bun:sqlite` driver via `drizzle-orm/bun-sqlite`. The module is loaded
 *   dynamically so this file is safe to import under Node.js.
 * - **Bun + remote URL** (`libsql:`, `http:`, `https:`, …) — stays on
 *   `@libsql/client` via `drizzle-orm/libsql`; `bun:sqlite` cannot handle
 *   remote connections.
 * - **Node.js** — always uses `@libsql/client` via `drizzle-orm/libsql`, which
 *   rejects in-memory URLs (a libsql transaction takes over the connection and
 *   the database with it): use a temporary database file.
 *
 * For local SQLite databases, automatically enables:
 * - `file:` URLs: WAL journal mode, 5-second busy timeout, and foreign key enforcement
 *   (busy timeout and foreign keys on every connection the handle opens)
 * - in-memory (`bun:sqlite` only): foreign key enforcement only
 *
 * Local handles on either driver serialize their statements and transactions
 * per handle: see {@link HandleGate} for the contract.
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
