/**
 * Shared test utilities for import-resolver tests.
 *
 * Provides a minimal test lifecycle that sets up the unified sessions table
 * without the legacy adapter_sessions table or handlers.
 */
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { registerDrizzleSessionStorage } from '../../storage/drizzle-handler.js';

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Context provided by {@link useImportResolverTestLifecycle}.
 */
export interface ImportResolverTestContext {
  /** Database instance (only valid inside a test). */
  readonly db: MakaioDatabase;
}

/** Vitest lifecycle hooks needed for test context setup. */
interface VitestLifecycle {
  beforeEach: (fn: () => Promise<void>) => void;
  afterEach: (fn: () => void) => void;
}

/**
 * Options for creating a test database.
 */
export interface CreateImportTestDbOptions {
  /**
   * Register additional bus handlers after core handlers are set up.
   * Receives the database instance. Returns a cleanup function.
   * @param db - Drizzle database instance
   */
  additionalHandlers?: (db: MakaioDatabase) => () => void;
}

/**
 * Registers beforeEach/afterEach hooks that create and tear down a test DB.
 *
 * Sets up the unified sessions table (no adapter_sessions) and registers the
 * drizzle session storage handlers. Use this for resolver tests that operate
 * purely on the sessions table.
 * @param lifecycle - Vitest lifecycle hooks (beforeEach, afterEach)
 * @param options - Optional configuration for additional handler registration
 * @returns Test context with lazy `db` access
 */
export function useImportResolverTestLifecycle(
  lifecycle: VitestLifecycle,
  options?: CreateImportTestDbOptions,
): ImportResolverTestContext {
  let _db: MakaioDatabase | undefined;
  let _cleanup: (() => void) | undefined;

  lifecycle.beforeEach(async () => {
    const { db, close, dbPath } = await createTempDb('import-resolver');

    await installSessionStorageTestSchema(db);

    const sessionCleanup = registerDrizzleSessionStorage(MakaioBus, db);
    const additionalCleanup = options?.additionalHandlers?.(db);

    _db = db;
    _cleanup = createDbCleanup(
      () => {
        additionalCleanup?.();
        sessionCleanup();
      },
      close,
      dbPath,
    );
  });

  lifecycle.afterEach(() => {
    _cleanup?.();
    _db = undefined;
    _cleanup = undefined;
  });

  return {
    get db(): MakaioDatabase {
      if (!_db) throw new Error('Test DB not initialized - are you inside a test?');
      return _db;
    },
  };
}
