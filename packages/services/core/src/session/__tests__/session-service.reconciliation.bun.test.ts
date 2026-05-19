/**
 * Tests for MakaioSessionService startup reconciliation.
 *
 * Verifies that orphaned `active` turns left by a prior process crash are closed
 * with `error: 'process-restart'` and that `session.turn.completed` is emitted
 * for each reconciled turn.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type Turn } from '@makaio/contracts';
import { MakaioSessionService } from '../session-service.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { registerMemoryTurnStorage, TurnStorageSubjects } from '../turns/index.js';
import { resetBusHandlers } from './shared.js';

describe('MakaioSessionService - Startup Reconciliation', () => {
  let sessionService: MakaioSessionService;
  let sessionStorageCleanup: () => void;
  let eventStorageCleanup: () => void;
  let turnStorageCleanup: () => void;

  beforeEach(() => {
    resetBusHandlers();
    sessionStorageCleanup = registerMemorySessionStorage(MakaioBus);
    eventStorageCleanup = registerMemorySessionEventStorage(MakaioBus);
    turnStorageCleanup = registerMemoryTurnStorage(MakaioBus);
  });

  afterEach(() => {
    sessionService?.destroy();
    turnStorageCleanup();
    eventStorageCleanup();
    sessionStorageCleanup();
  });

  /**
   * Seed an active turn directly into storage, simulating an orphan left by a crash.
   * @param sessionId - Session the turn belongs to
   * @returns The created active turn
   */
  async function seedActiveTurn(sessionId: string): Promise<Turn> {
    const { turn } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId });
    return turn;
  }

  it('closes orphaned active turns on init with error status', async () => {
    const sessionId = 'session-orphan-1';
    const { turn: orphan } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId });

    sessionService = new MakaioSessionService(MakaioBus);
    await sessionService.init();

    const { turn: after } = await MakaioBus.request(TurnStorageSubjects.get, { turnId: orphan.turnId });
    expect(after).not.toBeNull();
    expect(after?.status).toBe('error');
    expect(after?.error).toBe('process-restart');
    expect(after?.completedAt).toBeDefined();
  });

  it('emits session.turn.completed for each reconciled turn', async () => {
    const sessionId1 = 'session-orphan-a';
    const sessionId2 = 'session-orphan-b';

    const [turn1, turn2] = await Promise.all([seedActiveTurn(sessionId1), seedActiveTurn(sessionId2)]);

    const completedEvents: Array<{ sessionId: string; turnId: string; success: boolean; error?: string }> = [];
    const unsub = MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
      completedEvents.push({
        sessionId: ctx.payload.sessionId,
        turnId: ctx.payload.turnId,
        success: ctx.payload.success,
        error: ctx.payload.error,
      });
    });

    try {
      sessionService = new MakaioSessionService(MakaioBus);
      await sessionService.init();

      expect(completedEvents).toHaveLength(2);

      const ids = completedEvents.map((e) => e.turnId);
      expect(ids).toContain(turn1.turnId);
      expect(ids).toContain(turn2.turnId);

      for (const event of completedEvents) {
        expect(event.success).toBe(false);
        expect(event.error).toBe('process-restart');
      }
    } finally {
      unsub();
    }
  });

  it('does not touch already-completed turns', async () => {
    const sessionId = 'session-completed';
    const { turn: active } = await MakaioBus.request(TurnStorageSubjects.create, { sessionId });

    // Complete the turn before service init
    await MakaioBus.request(TurnStorageSubjects.complete, { turnId: active.turnId, status: 'completed' });

    const completedEvents: string[] = [];
    const unsub = MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
      completedEvents.push(ctx.payload.turnId);
    });

    try {
      sessionService = new MakaioSessionService(MakaioBus);
      await sessionService.init();

      // Reconciliation should not emit turn.completed for already-completed turns
      expect(completedEvents).toHaveLength(0);

      const { turn: after } = await MakaioBus.request(TurnStorageSubjects.get, { turnId: active.turnId });
      expect(after?.status).toBe('completed');
    } finally {
      unsub();
    }
  });

  it('does not emit turn.completed when orphan was externally completed before reconcile update', async () => {
    resetBusHandlers();
    sessionStorageCleanup = registerMemorySessionStorage(MakaioBus);
    eventStorageCleanup = registerMemorySessionEventStorage(MakaioBus);

    const orphan: Turn = {
      turnId: 'turn-race-1',
      sessionId: 'session-race-1',
      turnNumber: 1,
      startedAt: Date.now(),
      status: 'active',
    };
    const externallyCompletedTurn: Turn = {
      ...orphan,
      status: 'completed',
      completedAt: orphan.startedAt + 1,
    };

    let completeCallCount = 0;
    let completeTurnId: string | undefined;
    let completeExpectedStatus: Turn['status'] | undefined;

    const turnStorageUnsubs = [
      MakaioBus.on(TurnStorageSubjects.listActive, (ctx) => {
        ctx.setResult({ turns: [orphan] });
      }),
      MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
        completeCallCount += 1;
        completeTurnId = ctx.payload.turnId;
        completeExpectedStatus = ctx.payload.expectedStatus;
        // Simulate a stale listActive snapshot where another component completed
        // the turn before reconciliation attempted to close it.
        ctx.setResult({ turn: externallyCompletedTurn, transitioned: false });
      }),
      MakaioBus.on(TurnStorageSubjects.get, (ctx) => {
        ctx.setResult({
          turn: ctx.payload.turnId === orphan.turnId ? externallyCompletedTurn : null,
        });
      }),
    ];
    turnStorageCleanup = () => turnStorageUnsubs.forEach((cleanup) => cleanup());

    const completedEvents: string[] = [];
    const unsub = MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
      completedEvents.push(ctx.payload.turnId);
    });

    try {
      sessionService = new MakaioSessionService(MakaioBus);
      await sessionService.init();

      expect(completeCallCount).toBe(1);
      expect(completeTurnId).toBe(orphan.turnId);
      expect(completeExpectedStatus).toBe('active');
      expect(completedEvents).toHaveLength(0);

      const { turn: after } = await MakaioBus.request(TurnStorageSubjects.get, { turnId: orphan.turnId });
      expect(after?.status).toBe('completed');
    } finally {
      unsub();
    }
  });

  it('does nothing when no active turns exist', async () => {
    const completedEvents: string[] = [];
    const unsub = MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
      completedEvents.push(ctx.payload.turnId);
    });

    try {
      sessionService = new MakaioSessionService(MakaioBus);
      await sessionService.init();

      expect(completedEvents).toHaveLength(0);
    } finally {
      unsub();
    }
  });

  it('skips reconciliation when no listActive handler is registered', async () => {
    // Clean slate — turn storage is NOT registered here
    resetBusHandlers();
    sessionStorageCleanup = registerMemorySessionStorage(MakaioBus);
    eventStorageCleanup = registerMemorySessionEventStorage(MakaioBus);
    turnStorageCleanup = () => {}; // nothing to clean up — no turn storage registered

    // Service init must not throw even when turn storage is absent
    sessionService = new MakaioSessionService(MakaioBus);
    await expect(sessionService.init()).resolves.toBeUndefined();
  });
});
