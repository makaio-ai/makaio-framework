/**
 * Turn ingestion seam tests.
 *
 * Exercises `ingestCompletedTurn` against real in-memory storage handlers
 * (turn, session, message, session-event) plus the Drizzle anchor-upsert
 * handler against a real temp SQLite database:
 * - four-point consumer contract on first ingestion
 * - anchor idempotency: re-ingestion is a storage no-op and emits nothing
 *   once the side effects are durably recorded
 * - emission resume: a partial failure after the anchor claim does not
 *   suppress the events forever; per-anchor serialization keeps concurrent
 *   ingestion exactly-once
 * - stable turnNumber watermark under re-ingestion
 * - empty-messages guard, error-status turns, session_events lifecycle rows
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { SessionMessage } from '@makaio/contracts';
import { createTempDb, createDbCleanup } from '@makaio/test-utils/drizzle-harness';
import { TurnStorageSubjects } from '../turns/index.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { registerMemoryTurnStorage } from '../turns/memory-handler.js';
import { registerMemoryMessageStorage } from '../messages/memory-handler.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { registerDrizzleTurnStorage } from '../turns/drizzle-handler.js';
import { registerDrizzleSessionStorage } from '../storage/drizzle-handler.js';
import { installSessionStorageTestSchema } from '../testing/storage-test-schema.js';
import { createSession } from '../storage/__tests__/shared.js';
import { ingestCompletedTurn, type IngestCompletedTurnParams, type IngestTurnMessage } from '../turn-ingest.js';
import { resetBusHandlers, getStoredEvents, createTestSession } from './shared.js';

type UnsubFn = () => void;

/**
 * Build the message list for a test turn: one user message followed by one
 * assistant message, with anchor-derived adapterMessageIds.
 * @param anchor - Turn anchor (adapterMessageId of the user message)
 * @param agentId - Agent attributed to the assistant message
 * @returns Messages in transcript order
 */
function buildTurnMessages(anchor: string, agentId = 'agent-1'): IngestTurnMessage[] {
  return [
    {
      adapterMessageId: anchor,
      role: 'user',
      contentText: 'hello',
      blocks: [{ type: 'text', content: 'hello' }],
      timestamp: 1_000,
    },
    {
      adapterMessageId: `${anchor}-reply`,
      role: 'assistant',
      contentText: 'hi there',
      blocks: [{ type: 'text', content: 'hi there' }],
      agentId,
      timestamp: 2_000,
    },
  ];
}

/**
 * Build baseline ingestion params for a completed turn.
 * @param sessionId - Target session
 * @param anchor - Turn anchor id
 * @param overrides - Field overrides
 * @returns Ingestion params
 */
function buildParams(
  sessionId: string,
  anchor: string,
  overrides: Partial<IngestCompletedTurnParams> = {},
): IngestCompletedTurnParams {
  return {
    sessionId,
    turnAnchorId: anchor,
    startedAt: 1_000,
    completedAt: 3_000,
    status: 'completed',
    ingestionMarker: 'backfill',
    messages: buildTurnMessages(anchor),
    ...overrides,
  };
}

describe('ingestCompletedTurn (memory storage)', () => {
  const SESSION_ID = 'ingest-session';
  let unsubs: UnsubFn[] = [];
  /** Detach message storage exactly once (partial-failure simulation + afterEach). */
  let detachMessageStorage: UnsubFn;
  let startedEvents: Array<{ turnId: string; turnNumber: number; messageId: string; agentIds: string[] }>;
  let completedEvents: Array<{ turnId: string; turnNumber: number; success: boolean; error?: string }>;
  let eventOrder: string[];

  beforeEach(async () => {
    resetBusHandlers();
    const messageStorageUnsub = registerMemoryMessageStorage(MakaioBus);
    let messageStorageDetached = false;
    detachMessageStorage = () => {
      if (messageStorageDetached) return;
      messageStorageDetached = true;
      messageStorageUnsub();
    };
    unsubs = [
      registerMemorySessionStorage(MakaioBus),
      registerMemoryTurnStorage(MakaioBus),
      registerMemorySessionEventStorage(MakaioBus),
      detachMessageStorage,
    ];

    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: SESSION_ID,
      session: createTestSession(SESSION_ID),
    });

    startedEvents = [];
    completedEvents = [];
    eventOrder = [];
    unsubs.push(
      MakaioBus.on(SessionSubjects.turn.started, (ctx) => {
        const { turnId, turnNumber, messageId, agentIds, ingestionMarker } = ctx.payload;
        expect(ingestionMarker).toBe('backfill');
        startedEvents.push({ turnId, turnNumber, messageId, agentIds });
        eventOrder.push('started');
      }),
      MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
        const { turnId, turnNumber, success, error, ingestionMarker } = ctx.payload;
        expect(ingestionMarker).toBe('backfill');
        completedEvents.push({ turnId, turnNumber, success, error });
        eventOrder.push('completed');
      }),
    );
  });

  afterEach(() => {
    unsubs.forEach((fn) => fn());
    unsubs = [];
  });

  it('first ingest creates the turn, links messages, and emits both events exactly once', async () => {
    const result = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));

    expect(result.created).toBe(true);
    expect(result.turnNumber).toBe(1);

    // Four-point contract point 2: turn row exists in completed state.
    const { turn } = await MakaioBus.request(TurnStorageSubjects.get, { turnId: result.turnId });
    expect(turn?.status).toBe('completed');
    expect(turn?.turnNumber).toBe(1);

    // Point 3: messages queryable via getByTurn with the real turnId.
    const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: result.turnId });
    expect(messages).toHaveLength(2);
    expect(messages.every((m: SessionMessage) => m.turnId === result.turnId)).toBe(true);

    // Point 4 + exactly-once: both events fired once, in order, with the
    // marker (asserted in the collectors) and the stable turn identity.
    expect(eventOrder).toEqual(['started', 'completed']);
    expect(startedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
    expect(startedEvents[0]).toMatchObject({ turnId: result.turnId, turnNumber: 1, agentIds: ['agent-1'] });
    expect(completedEvents[0]).toMatchObject({ turnId: result.turnId, turnNumber: 1, success: true });

    // The started event anchors on the first user message's messageId.
    const userMessage = messages.find((m: SessionMessage) => m.role === 'user');
    expect(startedEvents[0].messageId).toBe(userMessage?.messageId);
  });

  it('re-ingesting the same anchor is a storage no-op and emits nothing', async () => {
    const first = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));
    const second = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));

    expect(second.created).toBe(false);
    expect(second.turnId).toBe(first.turnId);
    expect(second.turnNumber).toBe(first.turnNumber);

    const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: first.turnId });
    expect(messages).toHaveLength(2);

    // ZERO additional events beyond the first ingestion.
    expect(startedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
  });

  it('assigns monotonic turn numbers and never renumbers on re-ingestion', async () => {
    const turn1 = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));
    const turn2 = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-2'));

    expect(turn1.turnNumber).toBe(1);
    expect(turn2.turnNumber).toBe(2);

    // Re-ingesting turn 1 after turn 2 exists must not renumber it.
    const replay = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));
    expect(replay.created).toBe(false);
    expect(replay.turnId).toBe(turn1.turnId);
    expect(replay.turnNumber).toBe(1);
  });

  it('persists the turn but skips events and warns when messages are empty', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-empty', { messages: [] }));

      expect(result.created).toBe(true);
      const { turn } = await MakaioBus.request(TurnStorageSubjects.get, { turnId: result.turnId });
      expect(turn?.status).toBe('completed');

      expect(startedEvents).toHaveLength(0);
      expect(completedEvents).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('without messages'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('resumes suppressed emission when a prior ingestion failed after claiming the anchor', async () => {
    // Simulate a partial failure: the anchor row is claimed, but message
    // persistence fails (message storage unavailable) before any lifecycle
    // side effect ran.
    detachMessageStorage();
    await expect(ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'))).rejects.toThrow();
    expect(startedEvents).toHaveLength(0);
    expect(completedEvents).toHaveLength(0);

    // Retry with message storage back: the anchor already exists
    // (created=false), but the missing turn.completed lifecycle row marks the
    // side effects as incomplete — the retry must persist messages AND emit.
    unsubs.push(registerMemoryMessageStorage(MakaioBus));
    const retry = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));

    expect(retry.created).toBe(false);
    const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: retry.turnId });
    expect(messages).toHaveLength(2);
    expect(eventOrder).toEqual(['started', 'completed']);
    expect(startedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);

    // A further re-ingestion emits nothing (side effects durably recorded).
    await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));
    expect(startedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
  });

  it('emits via the resume path when an anchor first ingested without messages gains them', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const empty = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-late', { messages: [] }));
      expect(empty.created).toBe(true);
      expect(completedEvents).toHaveLength(0);

      const withMessages = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-late'));
      expect(withMessages.created).toBe(false);
      expect(withMessages.turnId).toBe(empty.turnId);
      expect(startedEvents).toHaveLength(1);
      expect(completedEvents).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('concurrent ingestion of the same anchor emits exactly once (per-anchor serialization)', async () => {
    const [a, b] = await Promise.all([
      ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-race')),
      ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-race')),
    ]);

    expect(a.turnId).toBe(b.turnId);
    expect(a.turnNumber).toBe(b.turnNumber);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

    const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: a.turnId });
    expect(messages).toHaveLength(2);
    expect(startedEvents).toHaveLength(1);
    expect(completedEvents).toHaveLength(1);
  });

  it('propagates error status as success=false with the error string', async () => {
    await ingestCompletedTurn(
      MakaioBus,
      buildParams(SESSION_ID, 'anchor-err', { status: 'error', error: 'agent exploded' }),
    );

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].success).toBe(false);
    expect(completedEvents[0].error).toBe('agent exploded');
  });

  it('appends turn.started and turn.completed lifecycle rows to session_events', async () => {
    const result = await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));

    const events = await getStoredEvents(SESSION_ID);
    const started = events.filter((e) => e.type === 'turn.started');
    const completed = events.filter((e) => e.type === 'turn.completed');
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(started[0].payload).toMatchObject({ turnId: result.turnId, turnNumber: 1 });
    expect(completed[0].payload).toMatchObject({ turnId: result.turnId, success: true });

    // Re-ingestion appends no further lifecycle rows.
    await ingestCompletedTurn(MakaioBus, buildParams(SESSION_ID, 'anchor-1'));
    const eventsAfter = await getStoredEvents(SESSION_ID);
    expect(eventsAfter.filter((e) => e.type === 'turn.started')).toHaveLength(1);
    expect(eventsAfter.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Drizzle anchor-upsert handler (real temp SQLite database)
// ---------------------------------------------------------------------------

/**
 * SQL statement to create the turns table for testing.
 * Mirrors the schema from turns/schema.ts including the anchor unique index.
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
    initiator TEXT,
    turn_anchor_id TEXT,
    UNIQUE(session_id, turn_number),
    UNIQUE(session_id, turn_anchor_id)
  )
`;

describe('storage:turn.ingestCompleted (Drizzle, temp SQLite)', () => {
  let cleanup: () => void = () => {};

  beforeEach(async () => {
    resetBusHandlers();
    const { db, close, dbPath, exec } = await createTempDb('turn-ingest');
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
  });

  afterEach(() => cleanup());

  /**
   * Create a session row (FK prerequisite for turns).
   * @param sessionId - Session identifier
   */
  async function createSessionRow(sessionId: string): Promise<void> {
    const session = createSession({ sessionId });
    await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });
  }

  it('anchor conflict preserves turnId, turnNumber, and startedAt but updates completion fields', async () => {
    await createSessionRow('drizzle-session');

    const first = await MakaioBus.request(TurnStorageSubjects.ingestCompleted, {
      sessionId: 'drizzle-session',
      turnAnchorId: 'anchor-A',
      startedAt: 1_000,
      completedAt: 2_000,
      status: 'completed',
    });
    expect(first.created).toBe(true);
    expect(first.turn.turnNumber).toBe(1);

    // Add a second turn so a renumbering bug would be observable.
    const second = await MakaioBus.request(TurnStorageSubjects.ingestCompleted, {
      sessionId: 'drizzle-session',
      turnAnchorId: 'anchor-B',
      startedAt: 3_000,
      completedAt: 4_000,
      status: 'completed',
    });
    expect(second.turn.turnNumber).toBe(2);

    // Re-ingest anchor-A with different completion data and startedAt.
    const replay = await MakaioBus.request(TurnStorageSubjects.ingestCompleted, {
      sessionId: 'drizzle-session',
      turnAnchorId: 'anchor-A',
      startedAt: 9_999,
      completedAt: 5_000,
      status: 'error',
      error: 'replayed failure',
      usage: { total: { inputTokens: 10, outputTokens: 20 } },
    });

    expect(replay.created).toBe(false);
    expect(replay.turn.turnId).toBe(first.turn.turnId);
    expect(replay.turn.turnNumber).toBe(1);
    expect(replay.turn.startedAt).toBe(1_000);
    // Completion fields follow the latest ingestion.
    expect(replay.turn.completedAt).toBe(5_000);
    expect(replay.turn.status).toBe('error');
    expect(replay.turn.error).toBe('replayed failure');
    expect(replay.turn.usage).toMatchObject({ total: { inputTokens: 10, outputTokens: 20 } });
  });

  it('the same anchor in a different session creates an independent turn', async () => {
    await createSessionRow('session-one');
    await createSessionRow('session-two');

    const one = await MakaioBus.request(TurnStorageSubjects.ingestCompleted, {
      sessionId: 'session-one',
      turnAnchorId: 'shared-anchor',
      startedAt: 1_000,
      completedAt: 2_000,
      status: 'completed',
    });
    const two = await MakaioBus.request(TurnStorageSubjects.ingestCompleted, {
      sessionId: 'session-two',
      turnAnchorId: 'shared-anchor',
      startedAt: 1_500,
      completedAt: 2_500,
      status: 'completed',
    });

    expect(one.created).toBe(true);
    expect(two.created).toBe(true);
    expect(two.turn.turnId).not.toBe(one.turn.turnId);
    expect(two.turn.turnNumber).toBe(1);
    expect(two.turn.sessionId).toBe('session-two');
  });
});
