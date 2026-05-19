/**
 * Integration test for concurrent single-statement writes.
 *
 * Verifies that concurrent single-statement operations don't deadlock
 * when handlers share a single DB connection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { createTempDb, createDbCleanup, type TestDbContextWithCleanup } from '@makaio/test-utils/drizzle-harness';
import { makeStubExtensionContext } from '@makaio/test-utils';
import { installSessionStorageTestSchema } from '../../testing/storage-test-schema.js';
import { SessionStorageSubjects } from '../namespace.js';
import { TurnStorageSubjects } from '../../../turn/namespace.js';
import { registerDrizzleSessionStorage } from '../drizzle-handler.js';
import { registerDrizzleTurnStorage } from '../../turns/drizzle-handler.js';
import { registerDrizzleAgentStorage } from '../agent-drizzle-handler.js';
import { createSession } from './shared.js';

/**
 * SQL statement to create the turns table for testing.
 * Mirrors the schema from turns/schema.ts.
 */
const CREATE_TURNS_TABLE_SQL = sql`
  CREATE TABLE IF NOT EXISTS turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    turn_number INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'error')),
    error TEXT,
    usage TEXT,
    UNIQUE(session_id, turn_number)
  )
`;

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * Enables SQLite concurrency pragmas used by storage handlers.
 * @param db - Drizzle database instance
 */
async function configureConcurrencyPragmas(db: TestDbContextWithCleanup['db']): Promise<void> {
  await db.run(sql`PRAGMA journal_mode = WAL`);
  await db.run(sql.raw(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`));
}

/**
 * Reads the first scalar value from a pragma result row.
 * @param row - Single pragma result row
 * @returns First column value, or undefined when row is missing
 */
function getPragmaValue(row: Record<string, unknown> | undefined): unknown {
  if (!row) {
    return undefined;
  }

  const [value] = Object.values(row);
  return value;
}

/**
 * Creates a temp file SQLite database for concurrency testing.
 * Applies WAL mode + busy_timeout to exercise single-connection write contention.
 * @returns Test database context with cleanup that removes temp file
 */
async function createTestDb(): Promise<TestDbContextWithCleanup> {
  const { db, close, dbPath } = await createTempDb('concurrent-writes');
  await configureConcurrencyPragmas(db);

  await installSessionStorageTestSchema(db);
  await db.run(CREATE_TURNS_TABLE_SQL);

  // Register all storage handlers on the same db instance
  const stubCtx = makeStubExtensionContext(MakaioBus);
  const sessionCleanup = registerDrizzleSessionStorage(MakaioBus, db, stubCtx);
  const turnCleanup = registerDrizzleTurnStorage(MakaioBus, db, stubCtx);
  const agentCleanup = registerDrizzleAgentStorage(MakaioBus, db, stubCtx);

  // Combined cleanup: unsubscribe handlers, close connection, delete temp file
  const cleanup = createDbCleanup(
    () => {
      sessionCleanup();
      turnCleanup();
      agentCleanup();
    },
    close,
    dbPath,
  );

  return { db, close, dbPath, cleanup };
}

describe('concurrent single-statement writes', () => {
  let ctx: TestDbContextWithCleanup;
  let cleanup: () => void = () => {};

  beforeEach(async () => {
    ctx = await createTestDb();
    cleanup = ctx.cleanup;
  });

  afterEach(() => cleanup());

  it('should configure SQLite concurrency pragmas for contention tests', async () => {
    const journalModeRows = await ctx.db.all<Record<string, unknown>>(sql`PRAGMA journal_mode`);
    const configuredJournalMode = String(getPragmaValue(journalModeRows[0])).toLowerCase();
    expect(configuredJournalMode).toBe('wal');

    const busyTimeoutRows = await ctx.db.all<Record<string, unknown>>(sql`PRAGMA busy_timeout`);
    const configuredBusyTimeout = Number(getPragmaValue(busyTimeoutRows[0]));
    expect(configuredBusyTimeout).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('should not deadlock when concurrent session update and turn create race', async () => {
    // Create a session first (prerequisite for turns FK)
    const session = createSession({
      sessionId: 'concurrent-test',
      status: 'active',
      lastActivityAt: 1000,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    // Simulate the race: session update (from fire-and-forget event)
    // racing with turn create (from sequential RPC handler)
    const updatePromise = MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session: { ...session, lastActivityAt: 2000 },
    });

    const createTurnPromise = MakaioBus.request(TurnStorageSubjects.create, {
      sessionId: session.sessionId,
      turnId: 'turn-1',
    });

    // Both should succeed without SQLITE_BUSY deadlock
    const [updateResult, turnResult] = await Promise.all([updatePromise, createTurnPromise]);

    expect(updateResult.success).toBe(true);
    expect(turnResult.turn).not.toBeNull();
    expect(turnResult.turn.turnId).toBe('turn-1');

    // Verify both writes persisted
    const retrievedSession = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });
    expect(retrievedSession.session?.lastActivityAt).toBe(2000);

    const retrievedTurn = await MakaioBus.request(TurnStorageSubjects.get, {
      turnId: 'turn-1',
    });
    expect(retrievedTurn.turn).not.toBeNull();
    expect(retrievedTurn.turn?.sessionId).toBe('concurrent-test');
  });

  it('should handle multiple concurrent writes to different tables without deadlock', async () => {
    // Create initial session
    const session = createSession({
      sessionId: 'multi-concurrent',
      status: 'active',
      lastActivityAt: 1000,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    // Keep operation batches separate so TypeScript infers request-specific result types.
    const sessionOperations = Array.from({ length: 5 }, (_, i) =>
      MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session: { ...session, lastActivityAt: 2000 + i },
      }),
    );
    const turnOperations = Array.from({ length: 5 }, (_, i) =>
      MakaioBus.request(TurnStorageSubjects.create, {
        sessionId: session.sessionId,
        turnId: `turn-${i}`,
      }),
    );

    // All should succeed without deadlock.
    const [sessionResults, turnResults] = await Promise.all([
      Promise.all(sessionOperations),
      Promise.all(turnOperations),
    ]);

    for (const result of sessionResults) {
      expect(result.success).toBe(true);
    }

    for (const result of turnResults) {
      expect(result.turn).not.toBeNull();
    }

    // Verify all turns persisted
    const turns = await MakaioBus.request(TurnStorageSubjects.getBySession, {
      sessionId: session.sessionId,
    });
    expect(turns.turns).toHaveLength(5);
  });

  it('should serialize concurrent updates to the same row without corruption', async () => {
    // Create initial session
    const session = createSession({
      sessionId: 'serialize-test',
      status: 'active',
      lastActivityAt: 1000,
    });

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: session.sessionId,
      session,
    });

    // Fire 20 concurrent updates to the same session row
    const updates = Array.from({ length: 20 }, (_, i) =>
      MakaioBus.request(SessionStorageSubjects.set, {
        sessionId: session.sessionId,
        session: { ...session, lastActivityAt: 2000 + i },
      }),
    );

    // All should succeed
    const results = await Promise.all(updates);

    for (const result of results) {
      expect(result.success).toBe(true);
    }

    // Final value should be one of the updates (last write wins)
    const retrieved = await MakaioBus.request(SessionStorageSubjects.get, {
      sessionId: session.sessionId,
    });
    expect(retrieved.session?.lastActivityAt).toBeGreaterThanOrEqual(2000);
    expect(retrieved.session?.lastActivityAt).toBeLessThan(2020);
  });
});
