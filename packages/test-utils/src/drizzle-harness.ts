import { sql, type SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import {
  brandDatabase,
  findStorageEngine,
  getRawSqlExecutor,
  registerStorageEngine,
  type MakaioDatabase,
  type RawSqlExecutor,
  type RawSqlSession,
  type StorageEngine,
} from '@makaio/storage-drizzle';
import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const requireFromTestUtils = createRequire(import.meta.url);

export interface TestDbContext {
  /** Drizzle database instance */
  db: MakaioDatabase;
  /** Path to temp database file */
  dbPath: string;
  /**
   * Execute a raw SQL statement through the handle's dialect-portable
   * executor — the designated path for hand-written DDL/DML in test setups.
   * Row-returning reads go through `getRawSqlExecutor(db).all(...)` instead.
   */
  exec: (query: SQL) => Promise<{ rowsAffected: number }>;
  /** Close the database connection (may resolve asynchronously) */
  close: () => void | Promise<void>;
  /**
   * Combined cleanup: calls close and deletes the temp file (for convenience in afterEach/afterAll).
   * Requires a synchronously closing connection (true for all SQLite drivers); clients whose close
   * resolves asynchronously must use an awaited teardown such as {@link PluginTestDbContext.close}.
   */
  cleanup: () => void;
}

/**
 * Test database context with cleanup function included.
 * Use this when your test setup creates the cleanup function.
 */
export interface TestDbContextWithCleanup extends TestDbContext {
  cleanup: () => void;
}

/**
 * Suite-level test database context for plugin storage tests.
 *
 * Separates DB lifecycle (suite-level) from handler lifecycle (test-level).
 * This prevents rapid client creation/destruction that causes Neon/Rust panics.
 *
 * **Usage pattern:**
 * ```typescript
 * let dbContext: PluginTestDbContext;
 * let handlerCleanup: () => void;
 *
 * beforeAll(async () => {
 *   dbContext = await createPluginTestDb({ ... });
 * });
 *
 * beforeEach(async () => {
 *   await dbContext.clearData();
 *   handlerCleanup = dbContext.registerHandlers();
 * });
 *
 * afterEach(() => {
 *   handlerCleanup();
 * });
 *
 * afterAll(async () => {
 *   await dbContext.close();
 * });
 * ```
 */
export interface PluginTestDbContext {
  /** Drizzle database instance */
  db: MakaioDatabase;
  /** Path to temp database file */
  dbPath: string;
  /**
   * Execute a raw SQL statement through the handle's dialect-portable
   * executor — the designated path for hand-written DDL/DML in test setups.
   * Row-returning reads go through `getRawSqlExecutor(db).all(...)` instead.
   */
  exec: TestDbContext['exec'];
  /** Clear all table data (fast, for use in beforeEach) */
  clearData: () => Promise<void>;
  /** Register bus handlers, returns cleanup function */
  registerHandlers: () => () => void;
  /** Close database connection and delete temp file (for use in afterAll) */
  close: () => Promise<void>;
}

/**
 * Configuration for creating a plugin test database.
 */
export interface PluginTestDbConfig {
  /** Service name for temp file naming (e.g., 'artifacts', 'github-storage') */
  name: string;
  /** SQL statements to create tables and indices */
  schemas: SQL[];
  /** Table names to DELETE FROM during clearData (order matters for foreign keys) */
  tables: string[];
  /** Function to register bus handlers, returns cleanup function */
  registerHandlers: (db: MakaioDatabase) => () => void;
}

/**
 * Creates a temporary SQLite database for testing.
 * @param name - Service name for temp file naming
 * @returns Object with db, dbPath, close, and cleanup
 */
export async function createTempDb(name: string): Promise<TestDbContext> {
  const dbPath = path.join(os.tmpdir(), `makaio-${name}-test-${crypto.randomUUID()}.db`);
  const { db, close } = await createDatabaseClient({ url: `file:${dbPath}` });
  const rawSql = getRawSqlExecutor(db);
  try {
    await rawSql.run(sql`SELECT 1`);
  } catch (err) {
    await close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
  const cleanup = createDbCleanup(() => {}, close, dbPath);
  return { db, dbPath, exec: (query) => rawSql.run(query), close, cleanup };
}

/**
 * Creates a suite-level test database for plugin storage tests.
 *
 * Generalizes the common pattern of creating a temp SQLite database,
 * running schema SQL, and providing clearData/registerHandlers/close
 * lifecycle methods.
 * @param config - Plugin test database configuration
 * @returns Plugin test database context with lifecycle methods
 */
export async function createPluginTestDb(config: PluginTestDbConfig): Promise<PluginTestDbContext> {
  const dbPath = path.join(os.tmpdir(), `makaio-${config.name}-test-${crypto.randomUUID()}.db`);
  const { db, close: closeDb } = await createDatabaseClient({ url: `file:${dbPath}` });
  const rawSql = getRawSqlExecutor(db);

  try {
    for (const schema of config.schemas) {
      await rawSql.run(schema);
    }
  } catch (err) {
    await closeDb();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  const clearData = async (): Promise<void> => {
    for (const table of config.tables) {
      await rawSql.run(sql.raw(`DELETE FROM ${table}`));
    }
  };

  const registerHandlers = (): (() => void) => {
    return config.registerHandlers(db);
  };

  const close = async (): Promise<void> => {
    // Awaiting tolerates both synchronous and asynchronous driver teardown and
    // always yields a microtask before the file is unlinked.
    await closeDb();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors (file may already be deleted)
    }
  };

  return { db, dbPath, exec: (query) => rawSql.run(query), clearData, registerHandlers, close };
}

/**
 * Result of {@link createPgBrandedTestDb}.
 */
export interface PgBrandedTestDbContext {
  /** Postgres-branded database handle backed by an in-memory libsql connection. */
  db: MakaioDatabase;
  /** Serialized query chunks of every statement sent through the fake executor. */
  statements: string[];
}

/**
 * Import the Postgres storage engine from `@makaio/test-utils`' package graph.
 *
 * This helper owns the `@makaio/storage-pg` dev dependency. Resolving from
 * `import.meta.url` keeps strict package managers from treating the optional
 * engine as a dependency of `@makaio/storage-drizzle`, while the file-URL
 * dynamic import avoids a static engine import in framework artifacts.
 * @returns The Postgres storage engine exported by `@makaio/storage-pg`.
 */
async function importTestUtilsPostgresEngine(): Promise<StorageEngine> {
  const engineEntryPath = requireFromTestUtils.resolve('@makaio/storage-pg');
  const { storageEngine } = (await import(/* @vite-ignore */ pathToFileURL(engineEntryPath).href)) as {
    storageEngine: StorageEngine;
  };
  return storageEngine;
}

/**
 * Create a Postgres-branded test database without a Postgres server.
 *
 * Registers the REAL Postgres engine (set-if-absent) by dynamically resolving
 * and importing `@makaio/storage-pg` from this package's dependency graph —
 * never via a static import: this package ships bundled, and a static engine
 * import would be silently inlined into the core dist. With the real engine
 * registered, everything above the executor seam (migration gating,
 * engine-owned ledger naming and DDL, handler registration branches, bus
 * dispatch) runs real code; only the executor is a double — it carries the
 * `'postgres'` dialect and records every statement instead of executing it.
 * The handle itself is a real (unbranded) in-memory libsql instance that
 * exists only to satisfy `MakaioDatabase` and is never queried directly.
 * @returns Postgres-branded handle plus the recorded statement array.
 */
export async function createPgBrandedTestDb(): Promise<PgBrandedTestDbContext> {
  if (!findStorageEngine('postgres')) {
    let storageEngine: StorageEngine;
    try {
      storageEngine = await importTestUtilsPostgresEngine();
    } catch (cause) {
      throw new Error('createPgBrandedTestDb requires @makaio/storage-pg to be resolvable from @makaio/test-utils.', {
        cause,
      });
    }
    registerStorageEngine(storageEngine);
  }

  const statements: string[] = [];

  const session: RawSqlSession = {
    async run(query): Promise<{ rowsAffected: number }> {
      statements.push(JSON.stringify(query.queryChunks));
      return { rowsAffected: 0 };
    },
    async all<TRow extends Record<string, unknown>>(): Promise<TRow[]> {
      return [];
    },
  };

  const executor: RawSqlExecutor = {
    dialect: 'postgres',
    run: session.run,
    all: session.all,
    withSession: (fn) => fn(session),
  };

  const db: MakaioDatabase = brandDatabase(drizzle({ connection: { url: ':memory:' } }), 'postgres', executor);
  return { db, statements };
}

/**
 * Creates cleanup function for test database.
 * @param handlerCleanup - Storage handler cleanup function
 * @param close - Function to close the database connection. Must close synchronously
 *   (true for all SQLite drivers) — the temp file is unlinked immediately after the
 *   call, so clients whose close resolves asynchronously must use an awaited teardown
 *   such as {@link PluginTestDbContext.close} instead.
 * @param dbPath - Path to temp database file
 * @returns Cleanup function that closes connection and deletes temp file
 */
export function createDbCleanup(handlerCleanup: () => void, close: () => void, dbPath: string): () => void {
  return () => {
    handlerCleanup();
    close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup failures
    }
  };
}

/**
 * Result of {@link usePluginStorageTestLifecycle}.
 *
 * Provides lazy access to the database context that is initialized
 * during `beforeAll`.
 */
export interface PluginStorageTestContext {
  /** Database context (available after `beforeAll`). */
  get dbContext(): PluginTestDbContext;
}

/**
 * Registers vitest lifecycle hooks for plugin storage handler tests.
 *
 * Must be called at describe scope (synchronously during test collection).
 * Handles `createTestDb`, `clearData`, `registerHandlers`, cleanup and close.
 *
 * **Usage:**
 * ```typescript
 * const ctx = usePluginStorageTestLifecycle(() => createTestDb());
 *
 * it('should work', async () => {
 *   // ctx.dbContext is available here
 *   await MakaioBus.request(...);
 * });
 * ```
 * @param createTestDbFn - Function that creates the test database context
 * @returns Accessor for the initialized database context
 */
export function usePluginStorageTestLifecycle(
  createTestDbFn: () => Promise<PluginTestDbContext>,
): PluginStorageTestContext {
  let dbContext: PluginTestDbContext | undefined;
  let handlerCleanup: (() => void) | undefined;

  beforeAll(async () => {
    dbContext = await createTestDbFn();
  });

  beforeEach(async () => {
    if (!dbContext) {
      throw new Error('usePluginStorageTestLifecycle: createTestDbFn did not initialize db context');
    }
    await dbContext.clearData();
    handlerCleanup = dbContext.registerHandlers();
  });

  afterEach(() => {
    handlerCleanup?.();
    handlerCleanup = undefined;
  });

  afterAll(async () => {
    if (!dbContext) {
      return;
    }
    await dbContext.close();
  });

  return {
    get dbContext() {
      // Some suites destructure dbContext at describe-time only to trigger lifecycle registration.
      // Keep getter lazy-compatible and rely on hook guards for initialization errors.
      return dbContext!;
    },
  };
}
