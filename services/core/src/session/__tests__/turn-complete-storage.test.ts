import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import type { Turn } from '@makaio/contracts';
import { createDbCleanup, createTempDb } from '@makaio/test-utils/drizzle-harness';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { createSession } from '../storage/__tests__/shared.js';
import { registerDrizzleSessionStorage } from '../storage/drizzle-handler.js';
import { installSessionStorageTestSchema } from '../testing/storage-test-schema.js';
import { TurnStorageSubjects } from '../turns/index.js';
import { registerDrizzleTurnStorage } from '../turns/drizzle-handler.js';
import { registerMemoryTurnStorage } from '../turns/memory-handler.js';
import { resetBusHandlers } from './shared.js';

const CREATE_TURNS_TABLE_SQL = sql`
  CREATE TABLE turns (
    turn_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    turn_number INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    error TEXT,
    usage TEXT,
    initiator TEXT,
    turn_anchor_id TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
    UNIQUE(session_id, turn_number),
    UNIQUE(session_id, turn_anchor_id)
  )
`;

describe('storage:turn.complete', () => {
  let cleanup: () => void = () => {};

  afterEach(() => {
    cleanup();
    cleanup = () => {};
    vi.useRealTimers();
    resetBusHandlers();
  });

  /**
   * Assert that terminal turn completion is idempotent and late usage does not rewrite terminal metadata.
   * @param turn - Active turn to complete.
   */
  async function expectTerminalUsageMergePreservesCompletion(turn: Turn): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = await MakaioBus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'error',
      error: 'first failure',
      usage: { total: { inputTokens: 1, outputTokens: 2 } },
    });
    expect(first.transitioned).toBe(true);
    expect(first.turn).toMatchObject({
      completedAt: 1_000,
      status: 'error',
      error: 'first failure',
      usage: { total: { inputTokens: 1, outputTokens: 2 } },
    });

    vi.setSystemTime(5_000);
    const second = await MakaioBus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'completed',
      usage: { total: { inputTokens: 3, outputTokens: 4 } },
    });

    expect(second.transitioned).toBe(false);
    expect(second.turn).toMatchObject({
      completedAt: 1_000,
      status: 'error',
      error: 'first failure',
      usage: { total: { inputTokens: 3, outputTokens: 4 } },
    });
  }

  /**
   * Assert that expectedStatus protects an already-terminal turn from stale completion writes.
   * @param turn - Active turn to complete.
   */
  async function expectExpectedStatusRejectsTerminalOverwrite(turn: Turn): Promise<void> {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await MakaioBus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'completed',
      usage: { total: { inputTokens: 1, outputTokens: 2 } },
    });

    vi.setSystemTime(5_000);
    const stale = await MakaioBus.request(TurnStorageSubjects.complete, {
      turnId: turn.turnId,
      status: 'error',
      expectedStatus: 'active',
      error: 'stale failure',
      usage: { total: { inputTokens: 9, outputTokens: 9 } },
    });

    expect(stale.transitioned).toBe(false);
    expect(stale.turn).toMatchObject({
      completedAt: 1_000,
      status: 'completed',
      error: undefined,
      usage: { total: { inputTokens: 1, outputTokens: 2 } },
    });
  }

  it('keeps terminal metadata stable while merging late usage in memory storage', async () => {
    resetBusHandlers();
    cleanup = registerMemoryTurnStorage(MakaioBus);

    const { turn } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId: 'memory-session' });

    await expectTerminalUsageMergePreservesCompletion(turn);
  });

  it('does not overwrite a terminal memory turn when expected status no longer matches', async () => {
    resetBusHandlers();
    cleanup = registerMemoryTurnStorage(MakaioBus);

    const { turn } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId: 'memory-cas-session' });

    await expectExpectedStatusRejectsTerminalOverwrite(turn);
  });

  it('keeps terminal metadata stable while merging late usage in drizzle storage', async () => {
    resetBusHandlers();
    const { db, close, dbPath, exec } = await createTempDb('turn-complete-storage');
    await installSessionStorageTestSchema(db);
    await exec(CREATE_TURNS_TABLE_SQL);
    const sessionCleanup = registerDrizzleSessionStorage(MakaioBus, db);
    const turnCleanup = registerDrizzleTurnStorage(MakaioBus, db);
    cleanup = createDbCleanup(
      () => {
        sessionCleanup();
        turnCleanup();
      },
      close,
      dbPath,
    );

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'drizzle-session',
      session: createSession({ sessionId: 'drizzle-session' }),
    });
    const { turn } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId: 'drizzle-session' });

    await expectTerminalUsageMergePreservesCompletion(turn);
  });

  it('does not overwrite a terminal drizzle turn when expected status no longer matches', async () => {
    resetBusHandlers();
    const { db, close, dbPath, exec } = await createTempDb('turn-complete-storage-cas');
    await installSessionStorageTestSchema(db);
    await exec(CREATE_TURNS_TABLE_SQL);
    const sessionCleanup = registerDrizzleSessionStorage(MakaioBus, db);
    const turnCleanup = registerDrizzleTurnStorage(MakaioBus, db);
    cleanup = createDbCleanup(
      () => {
        sessionCleanup();
        turnCleanup();
      },
      close,
      dbPath,
    );

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: 'drizzle-cas-session',
      session: createSession({ sessionId: 'drizzle-cas-session' }),
    });
    const { turn } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId: 'drizzle-cas-session' });

    await expectExpectedStatusRejectsTerminalOverwrite(turn);
  });
});
