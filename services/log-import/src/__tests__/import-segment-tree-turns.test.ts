/**
 * Turn-aware importSegmentTree tests against real in-memory storage.
 *
 * Verifies the segment-tree import path routes reconstructed turns through
 * the turn ingestion seam:
 * - turn members get real turnId links (getByTurn returns them)
 * - session.turn.started/completed fire per turn AFTER messages are queryable
 * - ingestionMarker threads through to the emitted events (default 'backfill')
 * - segments without turns keep byte-identical legacy behavior (turnId null, no events)
 * - re-running the same segment is idempotent: no new turns, no new events, stable turnNumbers
 * - segment.isSidechain lands on the session row
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { ImportSegment, StorageMessagePayload } from '@makaio/ai-adapters-core';
import {
  MessageStorageSubjects,
  SessionStorageSubjects,
  TurnStorageSubjects,
  registerMemoryMessageStorage,
  registerMemorySessionEventStorage,
  registerMemorySessionStorage,
  registerMemoryTurnStorage,
} from '@makaio/services-core/session';
import { importSegmentTree } from '../generic-import-handlers.js';
import type { ImportSegmentTreeContext } from '../import-types.js';

const ADAPTER_NAME = 'test-turn-adapter';

/** A captured `session.turn.*` event payload. */
interface CapturedTurnEvent {
  type: 'started' | 'completed';
  turnId: string;
  turnNumber: number;
  ingestionMarker: string | undefined;
  /** Messages queryable via getByTurn at the moment the event fired. */
  queryableMessageIds: string[];
}

/**
 * Build a storage message payload for the test segment.
 * @param adapterSessionId - Adapter session the message belongs to
 * @param adapterMessageId - Deterministic adapter message ID
 * @param role - Message role
 * @param timestamp - Unix ms timestamp
 * @returns Storage-ready message payload
 */
function msg(
  adapterSessionId: string,
  adapterMessageId: string,
  role: 'user' | 'assistant',
  timestamp: number,
): StorageMessagePayload {
  return {
    adapterMessageId,
    role,
    contentText: `content of ${adapterMessageId}`,
    blocks: [{ type: 'text', content: `content of ${adapterMessageId}` }],
    agentId: 'main',
    adapterSessionId,
    timestamp,
  };
}

/**
 * Build a two-turn root segment plus one orphan message not referenced by any turn.
 * @param adapterSessionId - Adapter session ID for the segment
 * @returns Import segment with turns
 */
function buildTurnSegment(adapterSessionId: string): ImportSegment {
  return {
    adapterSessionId,
    lineage: { kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null },
    messages: [
      msg(adapterSessionId, 'u1', 'user', 1_000),
      msg(adapterSessionId, 'a1', 'assistant', 2_000),
      msg(adapterSessionId, 'u2', 'user', 3_000),
      msg(adapterSessionId, 'a2', 'assistant', 4_000),
      msg(adapterSessionId, 'orphan-1', 'user', 5_000),
    ],
    turns: [
      { turnAnchorId: 'u1', adapterMessageIds: ['u1', 'a1'], startedAt: 1_000, completedAt: 2_500 },
      { turnAnchorId: 'u2', adapterMessageIds: ['u2', 'a2'], startedAt: 3_000, completedAt: 4_500 },
    ],
  };
}

/**
 * Baseline segment-tree context for the tests.
 * @param overrides - Context field overrides
 * @returns Import context
 */
function buildCtx(overrides: Partial<ImportSegmentTreeContext> = {}): ImportSegmentTreeContext {
  return {
    adapterId: 'adapter-instance-turns',
    adapterName: ADAPTER_NAME,
    model: null,
    cwd: null,
    ...overrides,
  };
}

describe('importSegmentTree (turn-aware)', () => {
  const cleanups: Array<() => void> = [];
  let turnEvents: CapturedTurnEvent[];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    turnEvents = [];
    cleanups.push(
      registerMemorySessionStorage(MakaioBus),
      registerMemoryTurnStorage(MakaioBus),
      registerMemoryMessageStorage(MakaioBus),
      registerMemorySessionEventStorage(MakaioBus),
    );

    // Capture turn events and probe getByTurn INSIDE the handler: the members
    // must already be queryable when the event fires (four-point contract).
    cleanups.push(
      MakaioBus.on(SessionSubjects.turn.started, async (ctx) => {
        const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: ctx.payload.turnId });
        turnEvents.push({
          type: 'started',
          turnId: ctx.payload.turnId,
          turnNumber: ctx.payload.turnNumber,
          ingestionMarker: ctx.payload.ingestionMarker,
          queryableMessageIds: messages.map((m) => m.adapterMessageId ?? ''),
        });
      }),
      MakaioBus.on(SessionSubjects.turn.completed, async (ctx) => {
        const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: ctx.payload.turnId });
        turnEvents.push({
          type: 'completed',
          turnId: ctx.payload.turnId,
          turnNumber: ctx.payload.turnNumber,
          ingestionMarker: ctx.payload.ingestionMarker,
          queryableMessageIds: messages.map((m) => m.adapterMessageId ?? ''),
        });
      }),
    );
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      cleanups.pop()?.();
    }
  });

  it('links turn members to real turnIds and emits per-turn events after messages are queryable', async () => {
    const segment = buildTurnSegment('session-turn-aware');

    const result = await importSegmentTree(MakaioBus, segment, buildCtx({ ingestionMarker: 'live' }));

    expect(result.messageCount).toBe(5);
    expect(result.turnCount).toBe(2);

    // Two turn rows with monotonic turnNumbers
    const { turns } = await MakaioBus.request(TurnStorageSubjects.getBySession, { sessionId: result.sessionId });
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.turnNumber)).toEqual([1, 2]);
    expect(turns.every((t) => t.status === 'completed')).toBe(true);

    // AC4 (unit level): getByTurn returns the members with real turnId links
    const firstTurn = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: turns[0].turnId });
    expect(firstTurn.messages.map((m) => m.adapterMessageId)).toEqual(['u1', 'a1']);
    const secondTurn = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: turns[1].turnId });
    expect(secondTurn.messages.map((m) => m.adapterMessageId)).toEqual(['u2', 'a2']);

    // The orphan message persists with turnId: null via the remainder path
    const { messages } = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId: result.sessionId });
    const orphan = messages.find((m) => m.adapterMessageId === 'orphan-1');
    expect(orphan).toBeDefined();
    expect(orphan?.turnId).toBeNull();

    // started + completed per turn, marker threaded, members queryable at emit time
    expect(turnEvents.map((e) => e.type)).toEqual(['started', 'completed', 'started', 'completed']);
    expect(turnEvents.every((e) => e.ingestionMarker === 'live')).toBe(true);
    expect(turnEvents[0].queryableMessageIds).toEqual(['u1', 'a1']);
    expect(turnEvents[1].queryableMessageIds).toEqual(['u1', 'a1']);
    expect(turnEvents[3].queryableMessageIds).toEqual(['u2', 'a2']);
  });

  it('defaults the ingestion marker to backfill when the context omits it', async () => {
    const segment = buildTurnSegment('session-default-marker');

    await importSegmentTree(MakaioBus, segment, buildCtx());

    expect(turnEvents.length).toBeGreaterThan(0);
    expect(turnEvents.every((e) => e.ingestionMarker === 'backfill')).toBe(true);
  });

  it('keeps legacy behavior for segments without turns: turnId null, zero turn events', async () => {
    const segment: ImportSegment = {
      ...buildTurnSegment('session-legacy'),
      turns: undefined,
    };

    const result = await importSegmentTree(MakaioBus, segment, buildCtx({ ingestionMarker: 'live' }));

    expect(result.turnCount).toBe(0);
    expect(turnEvents).toHaveLength(0);

    const { turns } = await MakaioBus.request(TurnStorageSubjects.getBySession, { sessionId: result.sessionId });
    expect(turns).toHaveLength(0);

    const { messages } = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId: result.sessionId });
    expect(messages).toHaveLength(5);
    expect(messages.every((m) => m.turnId === null)).toBe(true);
  });

  it('is idempotent under re-import: no renumbering, no duplicate turns, no re-emitted events (AC12)', async () => {
    const segment = buildTurnSegment('session-idempotent');
    const ctx = buildCtx({ ingestionMarker: 'backfill' });

    const first = await importSegmentTree(MakaioBus, segment, ctx);
    const { turns: firstTurns } = await MakaioBus.request(TurnStorageSubjects.getBySession, {
      sessionId: first.sessionId,
    });
    const eventCountAfterFirst = turnEvents.length;
    expect(eventCountAfterFirst).toBe(4);

    const second = await importSegmentTree(MakaioBus, segment, ctx);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.turnCount).toBe(0);
    expect(turnEvents).toHaveLength(eventCountAfterFirst);

    const { turns: secondTurns } = await MakaioBus.request(TurnStorageSubjects.getBySession, {
      sessionId: first.sessionId,
    });
    expect(secondTurns).toHaveLength(2);
    // (sessionId, turnNumber) is a stable watermark: identity and ordinals unchanged
    expect(secondTurns.map((t) => [t.turnId, t.turnNumber])).toEqual(firstTurns.map((t) => [t.turnId, t.turnNumber]));
  });

  it('skips unknown turn member ids with a warning and ingests the remaining members', async () => {
    const segment = buildTurnSegment('session-missing-member');
    segment.turns = [
      { turnAnchorId: 'u1', adapterMessageIds: ['u1', 'ghost-id', 'a1'], startedAt: 1_000, completedAt: 2_500 },
    ];

    const result = await importSegmentTree(MakaioBus, segment, buildCtx());

    expect(result.turnCount).toBe(1);
    const { turns } = await MakaioBus.request(TurnStorageSubjects.getBySession, { sessionId: result.sessionId });
    expect(turns).toHaveLength(1);
    const { messages } = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: turns[0].turnId });
    expect(messages.map((m) => m.adapterMessageId)).toEqual(['u1', 'a1']);
  });

  it('skips reconstructed turns whose anchor message is missing', async () => {
    const segment = buildTurnSegment('session-missing-anchor');
    segment.turns = [
      { turnAnchorId: 'ghost-anchor', adapterMessageIds: ['ghost-anchor', 'a1'], startedAt: 1_000, completedAt: 2_500 },
    ];

    const result = await importSegmentTree(MakaioBus, segment, buildCtx());

    expect(result.turnCount).toBe(0);
    const { turns } = await MakaioBus.request(TurnStorageSubjects.getBySession, { sessionId: result.sessionId });
    expect(turns).toHaveLength(0);
    const { messages } = await MakaioBus.request(MessageStorageSubjects.getBySession, { sessionId: result.sessionId });
    expect(messages.find((message) => message.adapterMessageId === 'a1')?.turnId).toBeNull();
  });

  it('persists the segment isSidechain flag on the session row (AC9)', async () => {
    const segment: ImportSegment = {
      ...buildTurnSegment('session-sidechain'),
      isSidechain: true,
    };

    const result = await importSegmentTree(MakaioBus, segment, buildCtx());

    const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId: result.sessionId });
    expect(session?.isSidechain).toBe(true);
  });
});
