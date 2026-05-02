/**
 * Shared test utilities for adapter session storage Drizzle handler tests.
 */
import { sql } from 'drizzle-orm';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { registerAdapterRuntimeIdentityHandlers } from '../../../adapter-runtime/index.js';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { registerDrizzleAdapterSessionStorage } from '../drizzle-handler.js';
import { registerCreateAndLinkHandler } from '../handlers.js';
import { registerDrizzleSessionStorage } from '../../storage/drizzle-handler.js';

/**
 * SQL statement to create the adapter_sessions table for testing.
 * Mirrors the schema from schema.ts.
 */
const CREATE_ADAPTER_SESSIONS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS adapter_sessions (
    adapter_session_id TEXT PRIMARY KEY,
    adapter_name TEXT NOT NULL,
    parent_adapter_session_id TEXT,
    fork_point_message_id TEXT,
    session_id TEXT REFERENCES sessions(session_id),
    model TEXT,
    cwd TEXT,
    log_file_path TEXT,
    kind TEXT NOT NULL DEFAULT 'root' CHECK (kind IN ('root', 'fork', 'subagent', 'compress')),
    discovered_at INTEGER NOT NULL,
    started_at INTEGER NOT NULL DEFAULT 0, -- DEFAULT 0 is a test convenience; production rows always receive an explicit value via the upsert handler (startedAt ?? Date.now())
    status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered', 'imported', 'live', 'tracking'))
  )
`;

const CREATE_ADAPTERS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS adapters (
    adapter_id TEXT PRIMARY KEY,
    adapter_name TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    display_name TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    adapter_settings TEXT,
    capabilities TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(adapter_name, machine_id)
  )
`;

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Context provided by {@link useAdapterSessionTestLifecycle}.
 * The `db` getter returns the database instance for the current test.
 */
export interface AdapterSessionTestContext {
  /** Database instance (only valid inside a test). */
  readonly db: MakaioDatabase;
}

/** Vitest lifecycle hooks needed for test context setup. */
interface VitestLifecycle {
  beforeEach: (fn: () => Promise<void>) => void;
  afterEach: (fn: () => void) => void;
}

/**
 * Registers beforeEach/afterEach hooks that create and tear down a test DB.
 * Eliminates the duplicated lifecycle pattern across adapter-session test files.
 * @param lifecycle - Vitest lifecycle hooks (beforeEach, afterEach)
 * @param options - Optional configuration for additional handler registration
 * @returns Test context with lazy `db` access
 */
export function useAdapterSessionTestLifecycle(
  lifecycle: VitestLifecycle,
  options?: CreateTestDbOptions,
): AdapterSessionTestContext {
  let _db: MakaioDatabase | undefined;
  let _cleanup: (() => void) | undefined;

  lifecycle.beforeEach(async () => {
    const ctx = await createTestDb(options);
    _db = ctx.db;
    _cleanup = ctx.cleanup;
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

/**
 * Options for creating a test database.
 */
export interface CreateTestDbOptions {
  /**
   * Register additional bus handlers after core handlers are set up.
   * Receives the database instance. Returns a cleanup function.
   * @param db - Drizzle database instance
   */
  additionalHandlers?: (db: MakaioDatabase) => () => void;
}

/**
 * Creates a temp file SQLite database for testing adapter sessions.
 *
 * Uses a temp file in os.tmpdir() instead of :memory: to ensure
 * proper SQLite behavior including foreign key constraints.
 * @param options - Optional configuration for additional handler registration
 * @returns Test database context with cleanup that removes temp file
 */
export async function createTestDb(options?: CreateTestDbOptions): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath } = await createTempDb('adapter-session');

  // Create tables
  await installSessionStorageTestSchema(db);
  await db.run(CREATE_ADAPTER_SESSIONS_TABLE_SQL);
  await db.run(CREATE_ADAPTERS_TABLE_SQL);

  // Create indexes
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS uniq_adapter_sessions_log_file_path ON adapter_sessions(log_file_path)`,
  );

  const now = Date.now();
  await db.run(sql`
    INSERT INTO adapters (adapter_id, adapter_name, machine_id, display_name, enabled, created_at, updated_at)
    VALUES ('adapter-claude-code-local', 'claude-code', 'test-machine', 'Claude Code', 1, ${now}, ${now})
  `);

  // Register handlers - session storage needed for linkSession's forkPointMessageId propagation
  const { cleanup: adapterStorageCleanup } = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
    currentMachineId: 'test-machine',
  });
  const stubCtx = makeStubExtensionContext(MakaioBus);
  const sessionCleanup = registerDrizzleSessionStorage(MakaioBus, db, stubCtx);
  const adapterCleanup = registerDrizzleAdapterSessionStorage(MakaioBus, db, stubCtx);
  // createAndLink is a bus-layer RPC that wraps createAndLinkImportedSession; it must be
  // registered alongside the Drizzle storage handlers so the discovered handler can route
  // through the bus (matching production behaviour).
  const createAndLinkCleanup = registerCreateAndLinkHandler(MakaioBus);
  const additionalCleanup = options?.additionalHandlers?.(db);

  const cleanup = createDbCleanup(
    () => {
      additionalCleanup?.();
      createAndLinkCleanup();
      adapterCleanup();
      sessionCleanup();
      adapterStorageCleanup();
    },
    close,
    dbPath,
  );

  return { db, close, dbPath, cleanup };
}

/**
 * Creates a test Makaio session in the database for FK constraints.
 * @param db - Database instance
 * @param sessionId - Session ID to create
 */
export async function createTestSession(db: MakaioDatabase, sessionId: string): Promise<void> {
  await db.run(sql`
    INSERT INTO sessions (session_id, created_at, last_activity_at, status, is_orchestrated, is_imported)
    VALUES (${sessionId}, 0, 0, 'active', 0, 0)
  `);
}
