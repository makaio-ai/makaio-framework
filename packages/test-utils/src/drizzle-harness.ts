import { sql, type SQL } from 'drizzle-orm';
import { createDatabaseClient } from '@makaio/storage-drizzle/client';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface TestDbContext {
  /** Drizzle database instance */
  db: MakaioDatabase;
  /** Path to temp database file */
  dbPath: string;
  /** Close database connection and delete temp file */
  close: () => void;
  /** Combined cleanup: calls close (for convenience in afterEach/afterAll) */
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
  try {
    await db.run(sql`SELECT 1`);
  } catch (err) {
    close();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
  const cleanup = createDbCleanup(() => {}, close, dbPath);
  return { db, dbPath, close, cleanup };
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

  try {
    for (const schema of config.schemas) {
      await db.run(schema);
    }
  } catch (err) {
    closeDb();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  const clearData = async (): Promise<void> => {
    for (const table of config.tables) {
      await db.run(sql.raw(`DELETE FROM ${table}`));
    }
  };

  const registerHandlers = (): (() => void) => {
    return config.registerHandlers(db);
  };

  const close = async (): Promise<void> => {
    closeDb();
    await Promise.resolve();
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // Ignore cleanup errors (file may already be deleted)
    }
  };

  return { db, dbPath, clearData, registerHandlers, close };
}

/**
 * Creates cleanup function for test database.
 * @param handlerCleanup - Storage handler cleanup function
 * @param close - Function to close the database connection
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
