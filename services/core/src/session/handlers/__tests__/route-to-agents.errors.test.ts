import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { HookAbortError } from '@makaio/hooks';
import { Turn, type TurnResult } from '../../entities/turn.js';
import {
  registerFailingSendHandler,
  registerSuccessfulSendHandler,
  createRouteTestContext,
  ROUTE_TEST_IDS,
  routeToAgentsWithTestLedger as routeToAgents,
  type RouteTestContext,
} from './shared.js';
import { createTestAgent, createTestSession, waitForAsync } from '../../__tests__/shared.js';

/** Type for the onTurnComplete callback */
type OnTurnCompleteCallback = (turn: Turn, result: { success: boolean; errors: string[] }) => Promise<void>;

describe('routeToAgents - error handling', () => {
  const { sessionId, messageId, turnId, testMessage } = ROUTE_TEST_IDS;
  let ctx: RouteTestContext;

  beforeEach(() => {
    ctx = createRouteTestContext();
  });

  afterEach(() => {
    ctx.destroy();
    vi.restoreAllMocks();
  });

  /**
   * Shorthand for ctx.trackUnsubscribe.
   * @param unsub - Unsubscribe function to track
   */
  const trackUnsubscribe = (unsub: () => void) => ctx.trackUnsubscribe(unsub);

  describe('should mark agent as errored on routing failure', () => {
    it('settles every directly terminalized agent before completing a mixed-failure turn', async () => {
      const settlements: Array<{ sessionId: string; turnId: string; messageId: string; agentId: string }> = [];
      trackUnsubscribe(
        MakaioBus.on(AgentSubjects.sendMessage, (context) => {
          if (context.payload.agentId === 'agent-1') {
            throw new Error('Agent unreachable');
          }
          throw new HookAbortError('policy-check', 'cancel requested');
        }),
      );
      trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, ({ payload }) => {
          settlements.push(payload);
        }),
      );

      const agents = [createTestAgent('agent-1'), createTestAgent('agent-2')];
      const session = createTestSession(sessionId, { agents });
      const turn = new Turn({
        sessionId,
        agentIds: agents.map((agent) => agent.agentId),
        turnId,
        turnNumber: 1,
      });
      const onTurnComplete = vi.fn(async () => {
        expect(settlements).toHaveLength(2);
      });

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents,
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      expect(settlements).toEqual(
        expect.arrayContaining([
          { sessionId, turnId, messageId, agentId: 'agent-1' },
          { sessionId, turnId, messageId, agentId: 'agent-2' },
        ]),
      );
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
    });

    it.each([
      'user-message completion',
      'assistant-persistence settlement',
    ] as const)('terminalizes a cancelled agent when the %s observer rejects', async (failedObserver) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      let observerCalls = 0;
      if (failedObserver === 'user-message completion') {
        trackUnsubscribe(
          MakaioBus.on(SessionSubjects.user_message.completed, () => {
            observerCalls += 1;
            throw new Error('user-message observer failed');
          }),
        );
      } else {
        trackUnsubscribe(
          MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, () => {
            observerCalls += 1;
            throw new Error('persistence observer failed');
          }),
        );
      }
      trackUnsubscribe(
        MakaioBus.on(AgentSubjects.sendMessage, () => {
          throw new HookAbortError('policy-check', 'cancel requested');
        }),
      );

      const agent = createTestAgent('agent-1');
      const session = createTestSession(sessionId, { agents: [agent] });
      const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
      const onTurnComplete = vi.fn<OnTurnCompleteCallback>().mockResolvedValue(undefined);

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      expect(observerCalls).toBe(1);
      expect(turn.isComplete()).toBe(true);
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(onTurnComplete).toHaveBeenCalledWith(turn, expect.objectContaining({ success: true }));
    });

    it('keeps the accepted agent active when acknowledgement observation fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      trackUnsubscribe(registerSuccessfulSendHandler());
      trackUnsubscribe(
        MakaioBus.on(SessionSubjects.user_message.acknowledged, () => {
          throw new Error('Acknowledgement persistence failed');
        }),
      );

      const settlements: Array<{ sessionId: string; turnId: string; agentId: string }> = [];
      trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, ({ payload }) => {
          settlements.push(payload);
        }),
      );

      const agent = createTestAgent('agent-1');
      const session = createTestSession(sessionId, { agents: [agent] });
      const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
      const onTurnComplete = vi.fn<OnTurnCompleteCallback>();

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      expect(settlements).toEqual([]);
      expect(turn.isComplete()).toBe(false);
      expect(onTurnComplete).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[SessionRouting] Failed to emit user-message acknowledgement:',
        expect.any(Error),
      );
    });

    it('marks agent as errored in Turn when sendMessage fails', async () => {
      const errorMessage = 'Agent unreachable';
      trackUnsubscribe(registerFailingSendHandler(new Set(['agent-1']), errorMessage));

      const agent = createTestAgent('agent-1');
      const session = createTestSession(sessionId, { agents: [agent] });
      const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
      const onTurnComplete = vi.fn();

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      expect(turn.isComplete()).toBe(true);
      // Bus wraps request errors with prefix, so we check the message contains our error
      expect(turn.getResult().errors.some((error) => error.includes(errorMessage))).toBe(true);
    });

    it('emits user_message.completed with error on failure', async () => {
      const errorMessage = 'Connection timeout';
      trackUnsubscribe(registerFailingSendHandler(new Set(['agent-1']), errorMessage));

      const completedEvents: Array<{
        sessionId: string;
        turnId: string;
        messageId: string;
        agentId: string;
        outcome: string;
        error: string | undefined;
      }> = [];

      const unsub = MakaioBus.on(SessionSubjects.user_message.completed, ({ payload }) => {
        completedEvents.push({
          sessionId: payload.sessionId,
          turnId: payload.turnId,
          messageId: payload.messageId,
          agentId: payload.agentId,
          outcome: payload.outcome,
          error: payload.error,
        });
      });
      trackUnsubscribe(unsub);

      const agent = createTestAgent('agent-1');
      const session = createTestSession(sessionId, { agents: [agent] });
      const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
      const onTurnComplete = vi.fn();

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      await waitForAsync();

      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0].sessionId).toBe(sessionId);
      expect(completedEvents[0].turnId).toBe(turnId);
      expect(completedEvents[0].messageId).toBe(messageId);
      expect(completedEvents[0].agentId).toBe('agent-1');
      expect(completedEvents[0].outcome).toBe('error');
      // Bus wraps request errors with prefix
      expect(completedEvents[0].error).toContain(errorMessage);
    });

    it('handles non-Error thrown values by converting to string', async () => {
      // Register a handler that throws a non-Error value
      const unsub = MakaioBus.on(AgentSubjects.sendMessage, () => {
        throw 'String error message';
      });
      trackUnsubscribe(unsub);

      const completedEvents: Array<{ error: string | undefined }> = [];
      const unsubCompleted = MakaioBus.on(SessionSubjects.user_message.completed, ({ payload }) => {
        completedEvents.push({ error: payload.error });
      });
      trackUnsubscribe(unsubCompleted);

      const agent = createTestAgent('agent-1');
      const session = createTestSession(sessionId, { agents: [agent] });
      const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
      const onTurnComplete = vi.fn();

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      await waitForAsync();

      expect(completedEvents).toHaveLength(1);
      // Bus wraps request errors, so we check the message contains our error
      expect(completedEvents[0].error).toContain('String error message');
    });

    it('marks multiple agents as errored independently', async () => {
      trackUnsubscribe(registerFailingSendHandler(new Set(['agent-1', 'agent-3']), 'Network error'));

      const agents = [createTestAgent('agent-1'), createTestAgent('agent-2'), createTestAgent('agent-3')];
      const session = createTestSession(sessionId, { agents });
      const turn = new Turn({
        sessionId,
        agentIds: agents.map((a) => a.agentId),
        turnId,
        turnNumber: 1,
      });
      const onTurnComplete = vi.fn();

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents,
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      // agent-1 and agent-3 should be errored
      expect(turn.getResult().errors).toHaveLength(2);

      // agent-2 should not be errored (it succeeded)
    });
  });

  describe('should complete turn if errored agent was last pending', () => {
    it('calls onTurnComplete when single agent errors', async () => {
      trackUnsubscribe(registerFailingSendHandler(new Set(['agent-1']), 'Fatal error'));

      const agent = createTestAgent('agent-1');
      const session = createTestSession(sessionId, { agents: [agent] });
      const turn = new Turn({ sessionId, agentIds: [agent.agentId], turnId, turnNumber: 1 });
      const onTurnComplete = vi.fn<OnTurnCompleteCallback>().mockResolvedValue(undefined);

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(onTurnComplete).toHaveBeenCalledWith(
        turn,
        expect.objectContaining({
          success: false,
        }),
      );
      // Bus wraps request errors, so verify the error contains our message
      const callArgs = onTurnComplete.mock.calls[0][1] as TurnResult;
      expect(callArgs.errors).toHaveLength(1);
      expect(callArgs.errors[0]).toContain('Fatal error');
    });

    it('calls onTurnComplete when last pending agent errors', async () => {
      // agent-1 succeeds fast, agent-2 errors
      const unsub = MakaioBus.on(AgentSubjects.sendMessage, async (context) => {
        if (context.payload.agentId === 'agent-1') {
          context.setResult({ messageId: 'id-1' });
        } else {
          // Small delay to ensure ordering
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('Agent-2 crashed');
        }
      });
      trackUnsubscribe(unsub);

      const agents = [createTestAgent('agent-1'), createTestAgent('agent-2')];
      const session = createTestSession(sessionId, { agents });
      const turn = new Turn({
        sessionId,
        agentIds: agents.map((a) => a.agentId),
        turnId,
        turnNumber: 1,
      });

      // This message targets only the still-pending agent.
      turn.admitMessage(messageId, [agents[1].agentId]);
      turn.commitMessageAdmission(messageId);

      const onTurnComplete = vi.fn<OnTurnCompleteCallback>().mockResolvedValue(undefined);

      await routeToAgents({
        bus: MakaioBus,
        session,
        // Only route to agent-2 (agent-1 already done)
        agents: [agents[1]],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      // Turn should complete because agent-1 was already completed and agent-2 errored
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(turn.isComplete()).toBe(true);
    });

    it('does not call onTurnComplete if other agents still pending', async () => {
      // First agent errors, second agent succeeds
      trackUnsubscribe(registerFailingSendHandler(new Set(['agent-1']), 'Error'));

      const agents = [createTestAgent('agent-1'), createTestAgent('agent-2')];
      const session = createTestSession(sessionId, { agents });
      const turn = new Turn({
        sessionId,
        agentIds: agents.map((a) => a.agentId),
        turnId,
        turnNumber: 1,
      });
      const onTurnComplete = vi.fn();

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents,
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      // Turn should NOT complete because agent-2 succeeded but isn't marked complete
      // (that happens via agent.complete event, not routing)
      expect(onTurnComplete).not.toHaveBeenCalled();
      expect(turn.isComplete()).toBe(false);
    });

    it('calls onTurnComplete with aggregated errors when all agents fail', async () => {
      trackUnsubscribe(registerFailingSendHandler(new Set(['agent-1', 'agent-2']), 'All agents down'));

      const agents = [createTestAgent('agent-1'), createTestAgent('agent-2')];
      const session = createTestSession(sessionId, { agents });
      const turn = new Turn({
        sessionId,
        agentIds: agents.map((a) => a.agentId),
        turnId,
        turnNumber: 1,
      });
      const onTurnComplete = vi.fn<OnTurnCompleteCallback>().mockResolvedValue(undefined);

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents,
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
      });

      // onTurnComplete could be called once or twice depending on timing
      // (each error checks for turn completion)
      expect(onTurnComplete).toHaveBeenCalled();

      // The final call should have both errors
      const lastCall = onTurnComplete.mock.calls[onTurnComplete.mock.calls.length - 1];
      const result = lastCall[1] as TurnResult;
      expect(result.success).toBe(false);
      expect(result.errors).toHaveLength(2);
      // Bus wraps request errors, so verify errors contain our message
      expect(result.errors.every((e) => e.includes('All agents down'))).toBe(true);
    });
  });
});
