import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type TurnIngestionMarker } from '@makaio/contracts';
import { TurnStorageSubjects } from '@makaio/services-core/turn';
import { createHook } from '../create-hook.js';

/**
 * PostTurn backfill filter.
 *
 * PostTurn consumers must not run for turns ingested from historical imports
 * (`session.turn.completed` with ingestionMarker `'backfill'`) unless they opt
 * in via `includeBackfill: true`. Live turns (marker `'live'` or absent) always
 * run. Filtered events still propagate to plain bus subscribers and perform no
 * context-enrichment storage queries.
 */
describe('PostTurn backfill filter', () => {
  /** Counts context-enrichment storage requests triggered by PostTurn hooks. */
  let sessionGetCalls: number;
  let turnsBySessionCalls: number;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    sessionGetCalls = 0;
    turnsBySessionCalls = 0;

    // Minimal storage stubs required by buildPostTurnContext, instrumented so
    // tests can assert that filtered events skip enrichment entirely.
    MakaioBus.on(SessionSubjects.get, (ctx) => {
      sessionGetCalls += 1;
      ctx.setResult({
        session: {
          sessionId: ctx.payload.sessionId,
          status: 'active',
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          agents: [],
        },
      });
    });
    MakaioBus.on(TurnStorageSubjects.getBySession, (ctx) => {
      turnsBySessionCalls += 1;
      ctx.setResult({ turns: [] });
    });
  });

  /**
   * Emit a `session.turn.completed` event with the given ingestion marker.
   * @param ingestionMarker - Marker to stamp on the emission; omit for legacy/managed events
   */
  async function emitTurnCompleted(ingestionMarker?: TurnIngestionMarker): Promise<void> {
    await MakaioBus.emit(SessionSubjects.turn.completed, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      turnNumber: 1,
      success: true,
      ...(ingestionMarker !== undefined ? { ingestionMarker } : {}),
    });
  }

  it("does not invoke the handler for ingestionMarker 'backfill' by default, but still propagates", async () => {
    const handler = vi.fn();
    const subscriber = vi.fn();
    createHook('PostTurn', { name: 'backfill-default', handler });
    MakaioBus.on(SessionSubjects.turn.completed, subscriber);

    await emitTurnCompleted('backfill');

    expect(handler).not.toHaveBeenCalled();
    // next() was called: the event reaches plain bus subscribers.
    expect(subscriber).toHaveBeenCalledTimes(1);
  });

  it("invokes the handler for ingestionMarker 'live'", async () => {
    const handler = vi.fn();
    createHook('PostTurn', { name: 'live-marker', handler });

    await emitTurnCompleted('live');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload.ingestionMarker).toBe('live');
  });

  it('invokes the handler when the marker is absent (legacy/managed compatibility)', async () => {
    const handler = vi.fn();
    createHook('PostTurn', { name: 'absent-marker', handler });

    await emitTurnCompleted();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload.ingestionMarker).toBeUndefined();
  });

  it("invokes the handler for 'backfill' when includeBackfill: true", async () => {
    const handler = vi.fn();
    createHook('PostTurn', { name: 'opt-in', includeBackfill: true, handler });

    await emitTurnCompleted('backfill');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].payload.ingestionMarker).toBe('backfill');
  });

  it('performs no context-enrichment storage requests for filtered events', async () => {
    createHook('PostTurn', { name: 'no-enrichment', handler: vi.fn() });

    await emitTurnCompleted('backfill');

    expect(sessionGetCalls).toBe(0);
    expect(turnsBySessionCalls).toBe(0);

    // Sanity check: a live emission through the same hook does enrich.
    await emitTurnCompleted('live');
    expect(sessionGetCalls).toBe(1);
    expect(turnsBySessionCalls).toBe(1);
  });
});
