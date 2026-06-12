/**
 * Conformance suite: turn and session-event storage handler families.
 *
 * Key invariants pinned here:
 * - Turns CTE concurrency: N=10 concurrent turn-creates for the same session all
 *   fulfil; the resulting turnNumbers are exactly 1..N with no duplicates. This
 *   guards the INSERT…SELECT next-turn-number CTE under PG MVCC concurrency.
 * - Session-events cursor monotonicity: appending K events and paging with the
 *   `after` cursor yields every event in order with no gaps or duplicates;
 *   ids are strictly increasing.
 * - Both dialect branches run the same assertions — no dialect-specific branches
 *   appear in this file.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  registerDrizzleSessionStorage,
  registerDrizzleTurnStorage,
  registerDrizzleSessionEventStorage,
  SessionStorageSubjects,
  TurnStorageSubjects,
  SessionEventStorageSubjects,
} from '@makaio/services-core/session';
import type { MakaioSessionEvent } from '@makaio/contracts';
import { describeStorageConformance } from '../harness/env.js';
import { useSuiteDatabaseContext } from '../harness/suite-context.js';
import { makeSession } from '../harness/fixture-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal `agent.added` session event for the append subject.
 * @param sessionId - Session this event belongs to.
 * @param index - Numeric suffix to guarantee unique eventIds across calls.
 * @returns Payload for SessionEventStorageSubjects.append.
 */
function makeAgentAddedEvent(sessionId: string, index: number): MakaioSessionEvent {
  return {
    sessionId,
    eventId: `evt-${sessionId}-${index}`,
    timestamp: Date.now() + index,
    type: 'agent.added',
    payload: {
      sessionId,
      agentId: `agent-${index}`,
    },
  } as MakaioSessionEvent;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describeStorageConformance('handlers-turns-events', (config) => {
  const getCtx = useSuiteDatabaseContext(config);
  const cleanups: Array<() => void> = [];

  beforeAll(() => {
    cleanups.push(registerDrizzleSessionStorage(MakaioBus, getCtx().db));
    cleanups.push(registerDrizzleTurnStorage(MakaioBus, getCtx().db));
    cleanups.push(registerDrizzleSessionEventStorage(MakaioBus, getCtx().db));
  });

  afterAll(() => {
    // Handlers unregister first; the context helper's afterAll (registered
    // earlier, therefore run later) releases the database afterwards.
    for (let i = cleanups.length - 1; i >= 0; i--) {
      cleanups[i]?.();
    }
  });

  // ─── 1. Turns CTE concurrency ────────────────────────────────────────────

  describe('turns CTE concurrency — INSERT…SELECT atomicity under concurrent load', () => {
    it('N=10 concurrent turn-creates produce exactly turnNumbers 1..10 with no duplicates', async () => {
      const N = 10;
      const sessionId = `sess-turns-${crypto.randomUUID()}`;
      const session = makeSession({ sessionId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      // Fire all creates concurrently
      const results = await Promise.all(
        Array.from({ length: N }, () => MakaioBus.request(TurnStorageSubjects.create, { sessionId })),
      );

      // All must succeed
      for (const result of results) {
        expect(result.turn).not.toBeNull();
        expect(result.turn.sessionId).toBe(sessionId);
      }

      // Collect assigned turn numbers
      const turnNumbers = results.map((r) => r.turn.turnNumber).sort((a, b) => a - b);

      // Exactly 1..N with no gaps and no duplicates
      const expected = Array.from({ length: N }, (_, i) => i + 1);
      expect(turnNumbers).toEqual(expected);
    });
  });

  // ─── 2. Session-events cursor monotonicity ───────────────────────────────

  describe('session-events cursor pagination', () => {
    it('pages through K events in insertion order — no gaps, no duplicates, ids strictly increasing', async () => {
      const K = 15;
      const PAGE = 5;
      const sessionId = `sess-events-${crypto.randomUUID()}`;
      const session = makeSession({ sessionId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      // Append K events sequentially (insertion order = autoincrement order)
      for (let i = 0; i < K; i++) {
        const appendResult = await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: makeAgentAddedEvent(sessionId, i),
        });
        expect(appendResult.success).toBe(true);
      }

      // Page through using the `after` cursor
      const collected: MakaioSessionEvent[] = [];
      let cursor: string | null = null;
      let pages = 0;

      for (;;) {
        const options: { limit: number; after?: string } = { limit: PAGE };
        if (cursor !== null) {
          options.after = cursor;
        }
        const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, { sessionId, options });
        expect(result.events.length).toBeGreaterThan(0);
        collected.push(...result.events);
        pages++;
        cursor = result.nextCursor;
        if (cursor === null) {
          break;
        }
      }

      // Union equals all K events
      expect(collected).toHaveLength(K);

      // Strict insertion order across every cursor boundary (this also pins
      // uniqueness and gaplessness). PG identity-column commit order vs the
      // '>'-cursor pagination is the tracked risk this assertion nets.
      expect(collected.map((e) => e.eventId)).toEqual(Array.from({ length: K }, (_, i) => `evt-${sessionId}-${i}`));

      // Pages advanced correctly (ceil(K/PAGE) pages)
      expect(pages).toBe(Math.ceil(K / PAGE));
    });

    it('first page without cursor returns events ordered by ascending id', async () => {
      const sessionId = `sess-order-${crypto.randomUUID()}`;
      const session = makeSession({ sessionId });
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session });

      const COUNT = 5;
      for (let i = 0; i < COUNT; i++) {
        await MakaioBus.request(SessionEventStorageSubjects.append, {
          event: makeAgentAddedEvent(sessionId, i),
        });
      }

      const result = await MakaioBus.request(SessionEventStorageSubjects.getEvents, {
        sessionId,
        options: { limit: COUNT },
      });

      expect(result.events).toHaveLength(COUNT);
      // Event IDs from the DB auto-increment; verify the returned slice is in order
      // by checking that each event's eventId matches the insertion sequence
      const returnedEventIds = result.events.map((e) => e.eventId);
      for (let i = 0; i < COUNT; i++) {
        expect(returnedEventIds[i]).toBe(`evt-${sessionId}-${i}`);
      }
    });
  });
});
