/**
 * Shared test utilities for session storage Drizzle handler tests.
 */
import { beforeEach, afterEach } from 'vitest';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import type { IMakaioSession, MakaioSessionAgent } from '@makaio/contracts';
import { installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { registerDrizzleSessionStorage } from '../drizzle-handler.js';
import { registerFtsSearchHandler } from '../fts-search-handler.js';
import { registerDrizzleAgentStorage } from '../agent-drizzle-handler.js';

/**
 * Creates a test agent with sensible defaults.
 * @param overrides - Properties to override
 * @returns A MakaioSessionAgent for testing
 */
export function createAgent(overrides: Partial<MakaioSessionAgent> = {}): MakaioSessionAgent {
  const now = Date.now();
  return {
    agentId: `agent-${Math.random().toString(36).slice(2)}`,
    adapterId: `adapter-${Math.random().toString(36).slice(2)}`,
    adapterName: 'test-adapter',
    sessionId: overrides.sessionId ?? `session-${Math.random().toString(36).slice(2)}`,
    role: 'member',
    status: 'idle',
    createdAt: now,
    lastActivityAt: now,
    ...overrides,
  };
}

/**
 * Creates a test session with sensible defaults.
 * All required fields are populated; overrides allow customization.
 * @param overrides - Partial session properties to merge with defaults
 * @returns A IMakaioSession for testing
 */
export function createSession(overrides: Partial<IMakaioSession> = {}): IMakaioSession {
  const now = Date.now();
  return {
    sessionId: `session-${Math.random().toString(36).slice(2)}`,
    createdAt: now,
    lastActivityAt: now,
    agents: [],
    status: 'active',
    isOrchestrated: false,
    isImported: false,
    // Storage defaults the currency state, so fixtures carry it too — otherwise
    // whole-record round-trip assertions drift by one field.
    currentAdapterSessionIdState: 'inherited',
    ...overrides,
  };
}

export type { TestDbContextWithCleanup as TestDbContext };

/**
 * Creates a temp file SQLite database for testing.
 *
 * Uses a temp file in os.tmpdir() instead of :memory: to ensure
 * proper SQLite behavior including foreign key constraints and
 * cascade deletes.
 * @returns Test database context with cleanup that removes temp file
 */
export async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath, exec } = await createTempDb('session');
  const handlerCleanups: Array<() => void> = [];
  const cleanupHandlers = (): void => {
    for (let i = handlerCleanups.length - 1; i >= 0; i--) {
      handlerCleanups[i]?.();
    }
  };

  try {
    await installSessionStorageTestSchema(db);

    // Register handlers
    handlerCleanups.push(registerDrizzleSessionStorage(MakaioBus, db));
    handlerCleanups.push(registerFtsSearchHandler(MakaioBus, db));
    handlerCleanups.push(registerDrizzleAgentStorage(MakaioBus, db));

    // Combined cleanup: unsubscribe handlers, close client, delete temp file
    const cleanup = createDbCleanup(cleanupHandlers, close, dbPath);

    return { db, close, dbPath, exec, cleanup };
  } catch (error) {
    // Setup can fail after the temp DB exists; tear it down eagerly to avoid leaking
    // file handles or partially registered bus handlers into later tests.
    createDbCleanup(cleanupHandlers, close, dbPath)();
    throw error;
  }
}

/**
 * Result of {@link useDrizzleTestLifecycle}.
 *
 * Provides lazy access to the database that is created fresh
 * in each `beforeEach`.
 */
export interface DrizzleTestContext {
  /** Drizzle database instance (available after `beforeEach`). */
  get db(): MakaioDatabase;

  /**
   * Execute a raw SQL statement through the database's dialect-portable
   * executor — the designated path for hand-written DDL/DML in test setups.
   * Row-returning reads go through `getRawSqlExecutor(db).all(...)` instead.
   */
  exec: TestDbContextWithCleanup['exec'];
}

/**
 * Registers vitest lifecycle hooks for session storage Drizzle tests.
 *
 * Must be called at describe scope (synchronously during test collection).
 * Creates a fresh database in beforeEach and cleans up in afterEach.
 * @returns Accessor for the initialised database context
 */
export function useDrizzleTestLifecycle(): DrizzleTestContext {
  let cleanup: (() => void) | undefined;
  let db: MakaioDatabase | undefined;
  let exec: TestDbContextWithCleanup['exec'] | undefined;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    exec = ctx.exec;
    cleanup = ctx.cleanup;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    db = undefined;
    exec = undefined;
  });

  return {
    get db() {
      if (!db) {
        throw new Error('useDrizzleTestLifecycle: test DB not initialized');
      }
      return db;
    },
    exec(query) {
      if (!exec) {
        throw new Error('useDrizzleTestLifecycle: test DB not initialized');
      }
      return exec(query);
    },
  };
}
