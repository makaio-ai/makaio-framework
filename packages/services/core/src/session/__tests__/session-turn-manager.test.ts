/**
 * SessionTurnManager tests.
 *
 * Tests the composable turn lifecycle manager in isolation, exercising:
 * - Turn creation with storage (in-memory handler)
 * - Turn creation without storage (ephemeral / synthetic IDs)
 * - Completion flow: agent.complete → completeTurn → turn.completed
 * - Usage accumulation via agent.usage events
 * - Concurrent completion guard
 * - Buffered usage during completion persistence
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { TurnInitiator } from '@makaio/contracts';
import { TurnStorageSubjects } from '../turns/index.js';
import { SessionTurnManager } from '../session-turn-manager.js';
import { resetBusHandlers, waitForAsync } from './shared.js';

// ---------------------------------------------------------------------------
// Minimal storage handler factories
// ---------------------------------------------------------------------------

type UnsubFn = () => void;

/**
 * Register a minimal in-memory turn storage handler.
 * @returns Unsubscribe function
 */
function registerTurnStorageHandlers(): UnsubFn {
  const nextBySession = new Map<string, number>();
  const turnsById = new Map<string, { sessionId: string; turnNumber: number; startedAt: number }>();
  const unsubs: UnsubFn[] = [];

  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.create, (ctx) => {
      const { sessionId } = ctx.payload;
      const turnNumber = (nextBySession.get(sessionId) ?? 0) + 1;
      nextBySession.set(sessionId, turnNumber);
      const turnId = ctx.payload.turnId ?? crypto.randomUUID();
      const startedAt = Date.now();
      turnsById.set(turnId, { sessionId, turnNumber, startedAt });
      ctx.setResult({
        turn: { turnId, sessionId, turnNumber, startedAt, status: 'active' },
      });
    }),
  );

  unsubs.push(
    MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
      const stored = turnsById.get(ctx.payload.turnId);
      if (!stored) throw new Error(`Mock: turn ${ctx.payload.turnId} not found`);
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

  return () => unsubs.forEach((u) => u());
}

/**
 * Collect turn.completed events.
 * @param unsubs - Array to push cleanup function into
 * @returns Collected payloads array
 */
function collectTurnCompleted(unsubs: UnsubFn[]): Array<{
  sessionId: string;
  turnId: string;
  turnNumber: number;
  success: boolean;
  error?: string;
  initiator?: TurnInitiator;
}> {
  const received: Array<{
    sessionId: string;
    turnId: string;
    turnNumber: number;
    success: boolean;
    error?: string;
    initiator?: TurnInitiator;
  }> = [];
  unsubs.push(
    MakaioBus.on(SessionSubjects.turn.completed, (ctx) => {
      const { sessionId, turnId, turnNumber, success, error, initiator } = ctx.payload;
      received.push({ sessionId, turnId, turnNumber, success, error, initiator });
    }),
  );
  return received;
}

/**
 * Collect user_message.completed events.
 * @param unsubs - Array to push cleanup function into
 * @returns Collected payloads array
 */
function collectUserMessageCompleted(unsubs: UnsubFn[]): Array<{
  sessionId: string;
  turnId: string;
  messageId: string;
  agentId: string;
  outcome: string;
  error?: string;
}> {
  const received: Array<{
    sessionId: string;
    turnId: string;
    messageId: string;
    agentId: string;
    outcome: string;
    error?: string;
  }> = [];
  unsubs.push(
    MakaioBus.on(SessionSubjects.user_message.completed, (ctx) => {
      const { sessionId, turnId, messageId, agentId, outcome, error } = ctx.payload;
      received.push({ sessionId, turnId, messageId, agentId, outcome, error });
    }),
  );
  return received;
}

/**
 * Emit agent.complete event.
 * @param agentId - Agent that completed
 * @param turnId - Turn the agent was in
 */
async function emitAgentComplete(agentId: string, turnId: string): Promise<void> {
  await MakaioBus.emit(AgentSubjects.complete, {
    agentId,
    adapterId: `adapter-${agentId}`,
    adapterName: 'test-adapter',
    adapterSessionId: `session-${agentId}`,
    turnId,
    messageId: `msg-${agentId}`,
  });
}

/**
 * Emit agent.complete event with error outcome.
 * @param agentId - Agent that errored
 * @param turnId - Turn the agent was in
 * @param error - Error message
 */
async function emitAgentError(agentId: string, turnId: string, error: string): Promise<void> {
  await MakaioBus.emit(AgentSubjects.complete, {
    agentId,
    adapterId: `adapter-${agentId}`,
    adapterName: 'test-adapter',
    adapterSessionId: `session-${agentId}`,
    turnId,
    messageId: `msg-${agentId}`,
    outcome: 'error' as const,
    error,
  });
}

const BASE_USAGE_FIELDS = {
  adapterId: 'adapter-test',
  adapterName: 'test-adapter',
  adapterSessionId: 'adapter-session',
  provider: 'test',
  model: 'test-model',
  inputCachedTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUnits: 0,
  costUnitType: 'tokens' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionTurnManager', () => {
  let manager: SessionTurnManager;
  let unsubs: UnsubFn[];

  beforeEach(() => {
    resetBusHandlers();
    unsubs = [];
  });

  afterEach(() => {
    manager?.destroy();
    unsubs.forEach((u) => u());
  });

  // -------------------------------------------------------------------------
  // createTurn — with storage
  // -------------------------------------------------------------------------

  describe('createTurn with storage handler', () => {
    it('returns a turn with storage-assigned turnId and turnNumber', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const turn = await manager.createTurn('session-1', ['agent-1']);

      expect(turn.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(turn.turnNumber).toBe(1);
      expect(turn.sessionId).toBe('session-1');
      expect(turn.agentIds).toEqual(['agent-1']);
    });

    it('increments turn numbers per session', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const t1 = await manager.createTurn('sess-a', ['agent-1']);

      // Complete first turn before creating second (can't have two active turns on same session)
      await manager.completeTurn(t1, { success: true, errors: [] });

      const t2 = await manager.createTurn('sess-a', ['agent-1']);

      expect(t1.turnNumber).toBe(1);
      expect(t2.turnNumber).toBe(2);
    });

    it('respects a pre-assigned turnId when passed', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const preAssignedId = 'pre-assigned-turn-id-1234';
      const turn = await manager.createTurn('session-1', ['agent-1'], undefined, preAssignedId);

      expect(turn.turnId).toBe(preAssignedId);
    });

    it('stores turn as active and makes it retrievable', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const turn = await manager.createTurn('sess-x', ['agent-a']);

      expect(manager.getActiveTurn('sess-x')).toBe(turn);
      expect(manager.findActiveTurnByTurnId(turn.turnId)).toBe(turn);
    });

    it('stores initiator on the turn', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const initiator: TurnInitiator = { source: 'extension', sourceId: 'my-extension' };
      const turn = await manager.createTurn('sess-1', ['agent-1'], initiator);

      expect(turn.initiator).toEqual(initiator);
    });
  });

  // -------------------------------------------------------------------------
  // createTurn — ephemeral (no storage handler)
  // -------------------------------------------------------------------------

  describe('createTurn without storage handler (ephemeral mode)', () => {
    it('returns a turn with synthetic UUID turnId', async () => {
      // No storage handlers registered
      manager = new SessionTurnManager(MakaioBus);

      const turn = await manager.createTurn('session-1', ['agent-1']);

      expect(turn.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('uses the pre-assigned turnId in ephemeral mode', async () => {
      manager = new SessionTurnManager(MakaioBus);

      const preAssignedId = 'ephemeral-turn-id-abc';
      const turn = await manager.createTurn('session-1', ['agent-1'], undefined, preAssignedId);

      expect(turn.turnId).toBe(preAssignedId);
    });

    it('generates synthetic incrementing turn numbers', async () => {
      manager = new SessionTurnManager(MakaioBus);

      const t1 = await manager.createTurn('sess-e', ['agent-1']);
      // Complete before creating next (simulate real flow)
      await manager.completeTurn(t1, { success: true, errors: [] });

      const t2 = await manager.createTurn('sess-e', ['agent-1']);

      expect(t1.turnNumber).toBe(1);
      expect(t2.turnNumber).toBe(2);
    });

    it('maintains separate counters per session', async () => {
      manager = new SessionTurnManager(MakaioBus);

      const t1a = await manager.createTurn('sess-a', ['agent-1']);
      const t1b = await manager.createTurn('sess-b', ['agent-2']);

      expect(t1a.turnNumber).toBe(1);
      expect(t1b.turnNumber).toBe(1);
    });

    it('stores turn as active', async () => {
      manager = new SessionTurnManager(MakaioBus);

      const turn = await manager.createTurn('sess-e2', ['agent-1']);

      expect(manager.getActiveTurn('sess-e2')).toBe(turn);
    });
  });

  // -------------------------------------------------------------------------
  // completeTurn
  // -------------------------------------------------------------------------

  describe('completeTurn', () => {
    it('emits turn.completed with success=true on successful completion', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-1', ['agent-a']);
      turn.addMessage('msg-1');

      await manager.completeTurn(turn, { success: true, errors: [] });

      expect(turnCompleted).toHaveLength(1);
      expect(turnCompleted[0]).toMatchObject({
        sessionId: 'sess-1',
        turnId: turn.turnId,
        turnNumber: turn.turnNumber,
        success: true,
      });
      expect(turnCompleted[0]?.error).toBeUndefined();
    });

    it('emits turn.completed with success=false and error when failed', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-2', ['agent-a']);

      await manager.completeTurn(turn, { success: false, errors: ['Agent timed out', 'Quota exceeded'] });

      expect(turnCompleted[0]).toMatchObject({
        success: false,
        error: 'Agent timed out; Quota exceeded',
      });
    });

    it('clears active turn from memory after completion', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const turn = await manager.createTurn('sess-3', ['agent-a']);

      expect(manager.getActiveTurn('sess-3')).toBe(turn);

      await manager.completeTurn(turn, { success: true, errors: [] });

      expect(manager.getActiveTurn('sess-3')).toBeUndefined();
      expect(manager.findActiveTurnByTurnId(turn.turnId)).toBeUndefined();
    });

    it('propagates initiator in turn.completed event', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const initiator: TurnInitiator = { source: 'extension', sourceId: 'my-routine' };
      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-4', ['agent-a'], initiator);

      await manager.completeTurn(turn, { success: true, errors: [] });

      expect(turnCompleted[0]?.initiator).toEqual(initiator);
    });

    it('works in ephemeral mode (no storage handler): still emits turn.completed', async () => {
      // No storage handlers registered
      manager = new SessionTurnManager(MakaioBus);

      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-eph', ['agent-a']);

      await manager.completeTurn(turn, { success: true, errors: [] });

      expect(turnCompleted).toHaveLength(1);
      expect(turnCompleted[0]).toMatchObject({ sessionId: 'sess-eph', success: true });
    });
  });

  // -------------------------------------------------------------------------
  // Concurrent completion guard
  // -------------------------------------------------------------------------

  describe('concurrent completion guard', () => {
    it('second concurrent completeTurn call is a no-op', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-c', ['agent-a', 'agent-b']);

      // Simulate two concurrent completions racing
      const [, secondResult] = await Promise.all([
        manager.completeTurn(turn, { success: true, errors: [] }),
        manager.completeTurn(turn, { success: true, errors: [] }),
      ]);

      expect(secondResult).toBeUndefined();
      // Only one turn.completed event emitted
      expect(turnCompleted).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Completion flow via registerCompletionHandlers
  // -------------------------------------------------------------------------

  describe('registerCompletionHandlers + full agent completion flow', () => {
    it('completes turn when single agent emits agent.complete', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-1', ['agent-1']);
      turn.addMessage('msg-1');

      await emitAgentComplete('agent-1', turn.turnId);
      await waitForAsync();

      expect(turnCompleted).toHaveLength(1);
      expect(turnCompleted[0]).toMatchObject({ sessionId: 'sess-1', success: true });
    });

    it('waits for all agents before completing turn', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-2', ['agent-1', 'agent-2']);
      turn.addMessage('msg-1');

      await emitAgentComplete('agent-1', turn.turnId);
      await waitForAsync();
      expect(turnCompleted).toHaveLength(0);

      await emitAgentComplete('agent-2', turn.turnId);
      await waitForAsync();
      expect(turnCompleted).toHaveLength(1);
    });

    it('completes turn as failed when an agent errors', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turnCompleted = collectTurnCompleted(unsubs);
      const turn = await manager.createTurn('sess-3', ['agent-1']);
      turn.addMessage('msg-1');

      await emitAgentError('agent-1', turn.turnId, 'Something went wrong');
      await waitForAsync();

      expect(turnCompleted).toHaveLength(1);
      expect(turnCompleted[0]).toMatchObject({ success: false, error: 'Something went wrong' });
    });

    it('emits user_message.completed per agent completion', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const userMsgCompleted = collectUserMessageCompleted(unsubs);
      const turn = await manager.createTurn('sess-4', ['agent-1', 'agent-2']);
      turn.addMessage('msg-a');
      turn.addMessage('msg-b');

      await emitAgentComplete('agent-1', turn.turnId);
      await waitForAsync();

      // Two messages × one agent = two events
      expect(userMsgCompleted).toHaveLength(2);
      expect(userMsgCompleted[0]).toMatchObject({ agentId: 'agent-1', outcome: 'completed' });
      expect(userMsgCompleted.every((e) => e.agentId === 'agent-1')).toBe(true);
    });

    it('ignores agent.complete events for unknown agents (not in any active turn)', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turnCompleted = collectTurnCompleted(unsubs);

      // Emit for an agent that was never registered in a turn
      await emitAgentComplete('unknown-agent', 'some-turn-id');
      await waitForAsync();

      expect(turnCompleted).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Usage accumulation
  // -------------------------------------------------------------------------

  describe('usage accumulation', () => {
    it('accumulates usage from agent.usage events and passes to TurnStorageSubjects.complete', async () => {
      const capturedUsages: Array<{ turnId: string; usage: unknown }> = [];
      unsubs.push(
        MakaioBus.on(TurnStorageSubjects.complete, async (ctx) => {
          capturedUsages.push({ turnId: ctx.payload.turnId, usage: ctx.payload.usage });
          await ctx.next();
        }),
      );
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turn = await manager.createTurn('sess-u', ['agent-1']);
      turn.addMessage('msg-1');

      await MakaioBus.emit(AgentSubjects.usage, {
        ...BASE_USAGE_FIELDS,
        agentId: 'agent-1',
        turnId: turn.turnId,
        inputTokens: 200,
        outputTokens: 80,
      });

      await emitAgentComplete('agent-1', turn.turnId);
      await waitForAsync();

      expect(capturedUsages).toHaveLength(1);
      expect(capturedUsages[0]?.turnId).toBe(turn.turnId);
      const usage = capturedUsages[0]?.usage as { total: { inputTokens: number } };
      expect(usage?.total.inputTokens).toBe(200);
    });

    it('aggregates usage from multiple agents', async () => {
      const capturedUsages: Array<{ usage: unknown }> = [];
      unsubs.push(
        MakaioBus.on(TurnStorageSubjects.complete, async (ctx) => {
          capturedUsages.push({ usage: ctx.payload.usage });
          await ctx.next();
        }),
      );
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turn = await manager.createTurn('sess-u2', ['agent-1', 'agent-2']);
      turn.addMessage('msg-1');

      await MakaioBus.emit(AgentSubjects.usage, {
        ...BASE_USAGE_FIELDS,
        agentId: 'agent-1',
        turnId: turn.turnId,
        inputTokens: 100,
        outputTokens: 40,
      });
      await MakaioBus.emit(AgentSubjects.usage, {
        ...BASE_USAGE_FIELDS,
        agentId: 'agent-2',
        turnId: turn.turnId,
        inputTokens: 300,
        outputTokens: 60,
      });

      await emitAgentComplete('agent-1', turn.turnId);
      await emitAgentComplete('agent-2', turn.turnId);
      await waitForAsync();

      const usage = capturedUsages[0]?.usage as {
        total: { inputTokens: number; outputTokens: number };
        byAgent: Record<string, { inputTokens: number; outputTokens: number }>;
      };
      expect(usage?.total.inputTokens).toBe(400);
      expect(usage?.total.outputTokens).toBe(100);
      expect(usage?.byAgent?.['agent-1']).toEqual({ inputTokens: 100, outputTokens: 40 });
      expect(usage?.byAgent?.['agent-2']).toEqual({ inputTokens: 300, outputTokens: 60 });
    });

    it('drops usage events that reference an inactive turn', async () => {
      const capturedUsages: Array<{ usage: unknown }> = [];
      unsubs.push(
        MakaioBus.on(TurnStorageSubjects.complete, async (ctx) => {
          capturedUsages.push({ usage: ctx.payload.usage });
          await ctx.next();
        }),
      );
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turn = await manager.createTurn('sess-late', ['agent-1']);
      turn.addMessage('msg-1');

      // Complete the turn first
      await emitAgentComplete('agent-1', turn.turnId);
      await waitForAsync();

      // Late usage event for the now-inactive turn — should be dropped silently
      await MakaioBus.emit(AgentSubjects.usage, {
        ...BASE_USAGE_FIELDS,
        agentId: 'agent-1',
        turnId: turn.turnId,
        inputTokens: 999,
        outputTokens: 0,
      });
      await waitForAsync();

      // No additional complete call, and first complete had no usage
      expect(capturedUsages).toHaveLength(1);
      expect(capturedUsages[0]?.usage).toBeUndefined();
    });

    it('drops usage events with no turnId', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turn = await manager.createTurn('sess-noturnid', ['agent-1']);
      turn.addMessage('msg-1');

      // Emit usage without turnId — should warn and drop
      await MakaioBus.emit(AgentSubjects.usage, {
        ...BASE_USAGE_FIELDS,
        agentId: 'agent-1',
        // no turnId
        inputTokens: 100,
        outputTokens: 50,
      });

      await emitAgentComplete('agent-1', turn.turnId);
      await waitForAsync();

      // Turn completes but with no usage
      expect(manager.getActiveTurn('sess-noturnid')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Buffered usage during completion
  // -------------------------------------------------------------------------

  describe('buffered usage during completion', () => {
    it('merges buffered usage into a second TurnStorageSubjects.complete call', async () => {
      const completeCalls: Array<{ usage: unknown }> = [];

      // Intercept the first complete call, emit a late usage event, then let it through
      let resolveFirstComplete: () => void;
      const firstCompleteStarted = new Promise<void>((resolve) => {
        resolveFirstComplete = resolve;
      });

      unsubs.push(
        MakaioBus.on(TurnStorageSubjects.complete, async (ctx) => {
          completeCalls.push({ usage: ctx.payload.usage });
          resolveFirstComplete();
          await ctx.next();
        }),
      );
      unsubs.push(registerTurnStorageHandlers());

      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turn = await manager.createTurn('sess-buf', ['agent-1']);
      turn.addMessage('msg-1');

      // Emit usage before completing
      await MakaioBus.emit(AgentSubjects.usage, {
        ...BASE_USAGE_FIELDS,
        agentId: 'agent-1',
        turnId: turn.turnId,
        inputTokens: 50,
        outputTokens: 20,
      });

      // Start completion (this will set completingSessions and call TurnStorageSubjects.complete)
      const completionPromise = manager.completeTurn(turn, { success: true, errors: [] });

      // Wait until completion persistence has started
      await firstCompleteStarted;

      // Emit late usage (arrives while completion is in-flight — should be buffered)
      await MakaioBus.emit(AgentSubjects.usage, {
        ...BASE_USAGE_FIELDS,
        agentId: 'agent-1',
        turnId: turn.turnId,
        inputTokens: 100,
        outputTokens: 30,
      });

      await completionPromise;
      await waitForAsync();

      // Exactly 2 complete calls: first with pre-completion usage (50 in / 20 out),
      // second with merged usage after buffered event (100 in / 30 out) is flushed.
      // The count is deterministic: one pre-completion usage event is emitted before
      // completeTurn(), one buffered event is emitted while completion is in-flight,
      // so the buffered-usage branch always executes and always issues a second call.
      expect(completeCalls.length).toBe(2);
      const lastCall = completeCalls[completeCalls.length - 1];
      const lastUsage = lastCall?.usage as
        | {
            total: { inputTokens: number; outputTokens: number };
          }
        | undefined;

      // Merged total: 50 + 100 = 150 input, 20 + 30 = 50 output (single agent-1 accumulator)
      expect(lastUsage).toBeDefined();
      expect(lastUsage!.total.inputTokens).toBe(150);
      expect(lastUsage!.total.outputTokens).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // findActiveTurnByTurnId
  // -------------------------------------------------------------------------

  describe('findActiveTurnByTurnId', () => {
    it('finds active turn by turnId across sessions', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);

      const turnA = await manager.createTurn('sess-a', ['agent-1']);
      const turnB = await manager.createTurn('sess-b', ['agent-2']);

      expect(manager.findActiveTurnByTurnId(turnA.turnId)).toBe(turnA);
      expect(manager.findActiveTurnByTurnId(turnB.turnId)).toBe(turnB);
    });

    it('returns undefined for unknown turnId', async () => {
      manager = new SessionTurnManager(MakaioBus);

      expect(manager.findActiveTurnByTurnId('nonexistent-turn-id')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    it('clears all state and stops reacting to events', async () => {
      unsubs.push(registerTurnStorageHandlers());
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      const turn = await manager.createTurn('sess-d', ['agent-1']);
      turn.addMessage('msg-1');

      const turnCompleted = collectTurnCompleted(unsubs);

      manager.destroy();

      // After destroy, agent.complete should not trigger completeTurn
      await emitAgentComplete('agent-1', turn.turnId);
      await waitForAsync();

      expect(turnCompleted).toHaveLength(0);
      expect(manager.getActiveTurn('sess-d')).toBeUndefined();
    });

    it('is idempotent — calling destroy twice does not throw', async () => {
      manager = new SessionTurnManager(MakaioBus);
      manager.registerCompletionHandlers(manager.completeTurn.bind(manager));

      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });
});
