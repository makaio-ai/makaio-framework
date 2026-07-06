/**
 * Persist-before-emit barrier tests (public contract, AC6/AC11).
 *
 * Drives the REAL seam: a real SessionTurnManager wired like the
 * SessionOrchestrator, a real SessionBridge persisting assistant messages on
 * `agent.complete`, and an artificial-delay message storage that emits
 * `storage:message.stored` after persistence (mirroring the production
 * handler contract in messages/shared.ts). Because the bus runs event
 * handlers in parallel, `session.turn.completed` must only be observed after
 * the delayed persistence side effect — that is the barrier under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { SessionMessage, TurnIngestionMarker } from '@makaio/contracts';
import { TurnStorageSubjects } from '../turns/index.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { SessionTurnManager, TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS } from '../session-turn-manager.js';
import { SessionBridge } from '../session-bridge.js';
import { MakaioSession } from '../entities/makaio-session.js';
import { emitSessionTurnStarted } from '../session-lifecycle-events.js';
import { registerMemorySessionEventStorage } from '../session-events/index.js';
import { getStoredEvents, resetBusHandlers, waitForAsync } from './shared.js';

type UnsubFn = () => void;

/**
 * Sleep helper for artificial persistence latency.
 * @param ms - Milliseconds to sleep
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register a minimal in-memory turn storage (create + complete).
 * @param unsubs - Array to push cleanup functions into
 */
function registerTurnStorage(unsubs: UnsubFn[]): void {
  const nextBySession = new Map<string, number>();
  const turnsById = new Map<string, { sessionId: string; turnNumber: number; startedAt: number }>();

  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.create, (ctx) => {
      const { sessionId } = ctx.payload;
      const turnNumber = (nextBySession.get(sessionId) ?? 0) + 1;
      nextBySession.set(sessionId, turnNumber);
      const turnId = ctx.payload.turnId ?? crypto.randomUUID();
      const startedAt = Date.now();
      turnsById.set(turnId, { sessionId, turnNumber, startedAt });
      ctx.setResult({ turn: { turnId, sessionId, turnNumber, startedAt, status: 'active' } });
    }),
  );
  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
      const stored = turnsById.get(ctx.payload.turnId);
      if (!stored) throw new Error(`turn ${ctx.payload.turnId} not created`);
      ctx.setResult({
        turn: {
          turnId: ctx.payload.turnId,
          sessionId: stored.sessionId,
          turnNumber: stored.turnNumber,
          startedAt: stored.startedAt,
          completedAt: Date.now(),
          status: ctx.payload.status,
          error: ctx.payload.error,
          usage: ctx.payload.usage,
        },
        transitioned: true,
      });
    }),
  );
}

/**
 * Register an in-memory message storage whose `append` resolves after an
 * artificial delay and then emits `storage:message.stored` — mirroring the
 * real handler contract (stored fires after persistence).
 * @param unsubs - Array to push cleanup functions into
 * @param appendDelayMs - Artificial persistence latency for append
 * @param sequence - Sequence log receiving `message-persisted:<role>` entries
 */
function registerDelayedMessageStorage(unsubs: UnsubFn[], appendDelayMs: number, sequence: string[]): void {
  const messagesByTurn = new Map<string, SessionMessage[]>();

  unsubs.push(
    MakaioBus.on(MessageStorageSubjects.append, async (ctx) => {
      await delay(appendDelayMs);
      const input = ctx.payload.message;
      const message: SessionMessage = {
        ...input,
        messageId: input.messageId ?? crypto.randomUUID(),
        blocks: input.blocks ?? [],
      };
      if (message.turnId) {
        const list = messagesByTurn.get(message.turnId) ?? [];
        list.push(message);
        messagesByTurn.set(message.turnId, list);
      }
      sequence.push(`message-persisted:${message.role}`);
      ctx.setResult({ message });
      // Mirror messages/shared.ts: stored fires after persistence completed.
      MakaioBus.emit(MessageStorageSubjects.stored, { message: structuredClone(message) });
    }),
  );
  unsubs.push(
    MakaioBus.on(MessageStorageSubjects.getByTurn, (ctx) => {
      ctx.setResult({ messages: messagesByTurn.get(ctx.payload.turnId) ?? [] });
    }),
  );
}

/**
 * Collect turn.completed payloads with turnNumber and ingestionMarker
 * (the shared collector captures neither).
 * @param unsubs - Array to push cleanup functions into
 * @param sequence - Optional sequence log receiving `turn-completed` entries
 * @returns Collected payloads
 */
function collectTurnCompleted(
  unsubs: UnsubFn[],
  sequence?: string[],
): Array<{
  sessionId: string;
  turnId: string;
  turnNumber: number;
  success: boolean;
  ingestionMarker?: TurnIngestionMarker;
}> {
  const received: Array<{
    sessionId: string;
    turnId: string;
    turnNumber: number;
    success: boolean;
    ingestionMarker?: TurnIngestionMarker;
  }> = [];
  unsubs.push(
    MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
      const { sessionId, turnId, turnNumber, success, ingestionMarker } = ctx.payload;
      sequence?.push('turn-completed');
      received.push({ sessionId, turnId, turnNumber, success, ingestionMarker });
    }),
  );
  return received;
}

/**
 * Emit an agent.complete event for the given agent/turn.
 * @param agentId - Completing agent
 * @param turnId - Turn the agent participated in
 */
async function emitAgentComplete(agentId: string, turnId: string): Promise<void> {
  await MakaioBus.emit(AgentSubjects.complete, {
    agentId,
    adapterId: `adapter-${agentId}`,
    adapterName: 'test-adapter',
    adapterSessionId: `native-${agentId}`,
    turnId,
    messageId: `msg-${agentId}`,
  });
}

/**
 * Emit an agent.message event so SessionBridge accumulates a text block.
 * @param agentId - Producing agent
 * @param content - Assistant text content
 */
async function emitAgentMessage(agentId: string, content: string): Promise<void> {
  await MakaioBus.emit(AgentSubjects.message, {
    agentId,
    adapterId: `adapter-${agentId}`,
    adapterName: 'test-adapter',
    adapterSessionId: `native-${agentId}`,
    messageId: `msg-${agentId}`,
    content,
  });
}

describe('turn completion persist-before-emit barrier', () => {
  let manager: SessionTurnManager;
  let bridge: SessionBridge | undefined;
  let unsubs: UnsubFn[];

  beforeEach(() => {
    resetBusHandlers();
    unsubs = [];
  });

  afterEach(() => {
    manager?.destroy();
    bridge?.destroy();
    bridge = undefined;
    unsubs.forEach((u) => u());
  });

  /**
   * Wire manager + bridge like SessionOrchestrator does, create a turn, and
   * prime the bridge's turn context via session.turn.started.
   * @param sessionId - Session under test
   * @param agentIds - Agents participating in the turn
   * @returns The created turn's identity
   */
  async function startManagedTurn(sessionId: string, agentIds: string[]): Promise<{ turnId: string }> {
    manager = new SessionTurnManager(MakaioBus);
    manager.registerCompletionHandlers(manager.completeTurn.bind(manager));
    bridge = new SessionBridge(MakaioBus);

    const turn = await manager.createTurn(sessionId, agentIds);
    turn.addMessage('msg-user-1');
    // Prime SessionBridge turn tracking (normally emitted by the orchestrator).
    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId,
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      messageId: 'msg-user-1',
      agentIds,
      ingestionMarker: 'live',
    });
    return { turnId: turn.turnId };
  }

  it('AC6: emits session.turn.completed strictly after delayed assistant persistence', async () => {
    const sequence: string[] = [];
    registerTurnStorage(unsubs);
    registerDelayedMessageStorage(unsubs, 50, sequence);
    const completed = collectTurnCompleted(unsubs, sequence);

    const { turnId } = await startManagedTurn('sess-barrier-1', ['agent-1']);
    await emitAgentMessage('agent-1', 'hello from the agent');
    await emitAgentComplete('agent-1', turnId);
    await waitForAsync();

    expect(completed).toHaveLength(1);
    expect(sequence).toEqual(['message-persisted:assistant', 'turn-completed']);
  });

  it('AC6 multi-agent: waits for one stored assistant message per agent', async () => {
    const sequence: string[] = [];
    registerTurnStorage(unsubs);
    registerDelayedMessageStorage(unsubs, 50, sequence);
    const completed = collectTurnCompleted(unsubs, sequence);

    const { turnId } = await startManagedTurn('sess-barrier-multi', ['agent-1', 'agent-2']);
    await emitAgentMessage('agent-1', 'first agent output');
    await emitAgentMessage('agent-2', 'second agent output');
    await emitAgentComplete('agent-1', turnId);
    await emitAgentComplete('agent-2', turnId);
    await waitForAsync();

    expect(completed).toHaveLength(1);
    expect(sequence.filter((s) => s === 'message-persisted:assistant')).toHaveLength(2);
    expect(sequence[sequence.length - 1]).toBe('turn-completed');
  });

  it('never hangs: zero-block agent (nothing persisted) still emits within the timeout bound', async () => {
    const sequence: string[] = [];
    registerTurnStorage(unsubs);
    registerDelayedMessageStorage(unsubs, 1, sequence);
    const completed = collectTurnCompleted(unsubs);

    const { turnId } = await startManagedTurn('sess-barrier-zero', ['agent-1']);
    // No agent.message: SessionBridge persists nothing (zero blocks, no error).
    const startedAt = Date.now();
    await emitAgentComplete('agent-1', turnId);
    const elapsed = Date.now() - startedAt;

    expect(completed).toHaveLength(1);
    // Barrier resolved via the mandatory timeout, not by hanging forever.
    expect(elapsed).toBeLessThan(TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS + 1000);
  }, 10000);

  it('ephemeral mode: no storage handlers at all → no barrier delay', async () => {
    const completed = collectTurnCompleted(unsubs);
    manager = new SessionTurnManager(MakaioBus);

    const turn = await manager.createTurn('sess-ephemeral', ['agent-1']);
    const startedAt = Date.now();
    await manager.completeTurn(turn, { success: true, errors: [] });
    const elapsed = Date.now() - startedAt;

    expect(completed).toHaveLength(1);
    expect(elapsed).toBeLessThan(TURN_COMPLETION_PERSISTENCE_TIMEOUT_MS / 2);
  });

  it('stamps ingestionMarker "live" on managed-path turn.started and turn.completed', async () => {
    registerTurnStorage(unsubs);
    const startedEvents: Array<{ turnNumber: number; ingestionMarker?: TurnIngestionMarker }> = [];
    unsubs.push(
      MakaioBus.on(SessionSubjects.turn.started, (ctx) => {
        startedEvents.push({ turnNumber: ctx.payload.turnNumber, ingestionMarker: ctx.payload.ingestionMarker });
      }),
    );
    const completed = collectTurnCompleted(unsubs);

    manager = new SessionTurnManager(MakaioBus);
    // Managed-path turn.started emit site: the MakaioSession aggregate.
    const session = new MakaioSession({ sessionId: 'sess-marker', bus: MakaioBus });
    const entityTurn = await session.startTurn({ agentIds: ['agent-1'], messageId: 'msg-1', turnNumber: 1 });
    entityTurn.markAgentCompleted('agent-1');

    // Managed-path turn.completed emit site: the SessionTurnManager.
    const turn = await manager.createTurn('sess-marker', ['agent-1']);
    await manager.completeTurn(turn, { success: true, errors: [] });

    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0]).toEqual({ turnNumber: 1, ingestionMarker: 'live' });
    expect(completed).toHaveLength(1);
    expect(completed[0].turnNumber).toBe(turn.turnNumber);
    expect(completed[0].ingestionMarker).toBe('live');
  });

  it('AC11: a completed managed turn leaves turn.started and turn.completed rows in session_events', async () => {
    registerTurnStorage(unsubs);
    unsubs.push(registerMemorySessionEventStorage(MakaioBus));

    manager = new SessionTurnManager(MakaioBus);
    manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

    const sessionId = 'sess-lifecycle-rows';
    const turn = await manager.createTurn(sessionId, ['agent-1']);
    turn.addMessage('msg-user-1');
    // The orchestrator's turn.started emit path (persists the lifecycle row).
    await emitSessionTurnStarted(MakaioBus, {
      sessionId,
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      messageId: 'msg-user-1',
      agentIds: ['agent-1'],
      initiator: turn.initiator,
      ingestionMarker: 'live',
    });
    await emitAgentComplete('agent-1', turn.turnId);
    await waitForAsync();

    const events = await getStoredEvents(sessionId);
    const types = events.map((e) => e.type);
    expect(types).toContain('turn.started');
    expect(types).toContain('turn.completed');

    const completedRow = events.find((e) => e.type === 'turn.completed');
    if (completedRow?.type === 'turn.completed') {
      expect(completedRow.payload.turnId).toBe(turn.turnId);
      expect(completedRow.payload.turnNumber).toBe(turn.turnNumber);
      expect(completedRow.payload.success).toBe(true);
      expect(completedRow.payload.ingestionMarker).toBe('live');
    }
  });

  it('ignores late storage:message.stored events for already-completed turns', async () => {
    registerTurnStorage(unsubs);
    const completed = collectTurnCompleted(unsubs);
    manager = new SessionTurnManager(MakaioBus);

    const turn = await manager.createTurn('sess-late-stored', ['agent-1']);
    await manager.completeTurn(turn, { success: true, errors: [] });
    expect(completed).toHaveLength(1);

    // Late stored event after the completion emitted — must be a no-op.
    await MakaioBus.emit(MessageStorageSubjects.stored, {
      message: {
        messageId: 'late-msg',
        turnId: turn.turnId,
        sessionId: 'sess-late-stored',
        role: 'assistant',
        contentText: 'late',
        blocks: [],
        timestamp: Date.now(),
      },
    });

    expect(completed).toHaveLength(1);
  });
});
