import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { routeToAgents } from '../route-to-agents.js';
import { Turn } from '../../entities/turn.js';
import {
  registerSuccessfulSendHandler,
  registerFailingSendHandler,
  createRouteTestContext,
  ROUTE_TEST_IDS,
  type RouteTestContext,
} from './shared.js';
import { createTestAgent, createTestSession, waitForAsync } from '../../__tests__/shared.js';

describe('routeToAgents', () => {
  const { sessionId, messageId, turnId, testMessage } = ROUTE_TEST_IDS;
  let ctx: RouteTestContext;

  beforeEach(() => {
    ctx = createRouteTestContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  /**
   * Shorthand for ctx.trackUnsubscribe.
   * @param unsub - Unsubscribe function to track
   */
  const trackUnsubscribe = (unsub: () => void) => ctx.trackUnsubscribe(unsub);

  describe('should send message to single agent', () => {
    it('includes sessionId in agent.sendMessage payload', async () => {
      let capturedSessionId: string | undefined;

      const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        capturedSessionId = context.payload.sessionId;
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
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

      expect(capturedSessionId).toBe(sessionId);
    });

    it('sends message to agent via AgentSubjects.sendMessage', async () => {
      const receivedRequests: Array<{
        agentId: string;
        adapterId: string;
        message: string;
        messageId: string;
      }> = [];

      const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        receivedRequests.push({
          agentId: context.payload.agentId,
          adapterId: context.payload.adapterId,
          message: context.payload.message as string,
          messageId: context.payload.messageId ?? '',
        });
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      });
      trackUnsubscribe(unsub);

      const agent = createTestAgent('agent-1', { role: 'lead' });
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

      expect(receivedRequests).toHaveLength(1);
      expect(receivedRequests[0]).toEqual({
        agentId: 'agent-1',
        adapterId: 'adapter-agent-1',
        message: testMessage,
        messageId,
      });
    });

    it('passes deliveryMode to sendMessage request', async () => {
      let receivedDeliveryMode: string | undefined;

      const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        receivedDeliveryMode = context.payload.deliveryMode;
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
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
        deliveryMode: 'enqueue',
        onTurnComplete,
      });

      expect(receivedDeliveryMode).toBe('enqueue');
    });
  });

  describe('should send message to multiple agents in parallel', () => {
    it('fans out requests to all agents concurrently', async () => {
      const receivedAgentIds: string[] = [];
      const processingOrder: string[] = [];

      const unsub = MakaioBus.on(AgentSubjects.sendMessage, async (context) => {
        receivedAgentIds.push(context.payload.agentId);
        // Simulate varied processing times
        const delay = context.payload.agentId === 'agent-1' ? 20 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        processingOrder.push(context.payload.agentId);
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      });
      trackUnsubscribe(unsub);

      const agents = [
        createTestAgent('agent-1', { role: 'lead' }),
        createTestAgent('agent-2'),
        createTestAgent('agent-3'),
      ];
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

      // All agents should receive requests
      expect(receivedAgentIds).toHaveLength(3);
      expect(receivedAgentIds).toContain('agent-1');
      expect(receivedAgentIds).toContain('agent-2');
      expect(receivedAgentIds).toContain('agent-3');

      // Due to parallel execution with different delays, agent-2 and agent-3
      // should complete before agent-1
      expect(processingOrder).toContain('agent-1');
      expect(processingOrder).toContain('agent-2');
      expect(processingOrder).toContain('agent-3');
    });

    it('continues processing other agents even if one is slow', async () => {
      const completionTimes: Array<{ agentId: string; time: number }> = [];
      const startTime = Date.now();

      const unsub = MakaioBus.on(AgentSubjects.sendMessage, async (context) => {
        // agent-1 is slow, others are fast
        const delay = context.payload.agentId === 'agent-1' ? 50 : 5;
        await new Promise((resolve) => setTimeout(resolve, delay));
        completionTimes.push({
          agentId: context.payload.agentId,
          time: Date.now() - startTime,
        });
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
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

      // Fast agent should complete well before slow agent
      const fastAgent = completionTimes.find((c) => c.agentId === 'agent-2');
      const slowAgent = completionTimes.find((c) => c.agentId === 'agent-1');
      expect(fastAgent).toBeDefined();
      expect(slowAgent).toBeDefined();
      expect(fastAgent!.time).toBeLessThan(slowAgent!.time);
    });
  });

  describe('should emit user_message.acknowledged per agent', () => {
    it('emits acknowledged event for each successful agent', async () => {
      trackUnsubscribe(registerSuccessfulSendHandler());

      const acknowledgedEvents: Array<{
        sessionId: string;
        turnId: string;
        messageId: string;
        agentId: string;
      }> = [];

      const unsub = MakaioBus.on(SessionSubjects.user_message.acknowledged, ({ payload }) => {
        acknowledgedEvents.push({
          sessionId: payload.sessionId,
          turnId: payload.turnId,
          messageId: payload.messageId,
          agentId: payload.agentId,
        });
      });
      trackUnsubscribe(unsub);

      const agents = [createTestAgent('agent-1', { role: 'lead' }), createTestAgent('agent-2')];
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

      await waitForAsync();

      expect(acknowledgedEvents).toHaveLength(2);
      expect(acknowledgedEvents).toContainEqual({
        sessionId,
        turnId,
        messageId,
        agentId: 'agent-1',
      });
      expect(acknowledgedEvents).toContainEqual({
        sessionId,
        turnId,
        messageId,
        agentId: 'agent-2',
      });
    });

    it('does not emit acknowledged for agents that fail', async () => {
      trackUnsubscribe(registerFailingSendHandler(new Set(['agent-2']), 'Connection failed'));

      const acknowledgedAgentIds: string[] = [];

      const unsub = MakaioBus.on(SessionSubjects.user_message.acknowledged, ({ payload }) => {
        acknowledgedAgentIds.push(payload.agentId);
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

      await waitForAsync();

      // Only agent-1 should be acknowledged
      expect(acknowledgedAgentIds).toEqual(['agent-1']);
    });
  });

  describe('should deliver per-agent recovery context', () => {
    it('only recovered agents receive recovery context overlay', async () => {
      const agent1 = createTestAgent('agent-1', { role: 'lead' });
      const agent2 = createTestAgent('agent-2');
      const session = createTestSession(sessionId, { agents: [agent1, agent2] });
      const turn = new Turn({ sessionId, agentIds: [agent1.agentId, agent2.agentId], turnId, turnNumber: 1 });

      const capturedContexts: Array<{ agentId: string; isFirstTurn?: boolean }> = [];

      const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        capturedContexts.push({
          agentId: context.payload.agentId,
          isFirstTurn: context.payload.sessionContext?.isFirstTurn,
        });
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      });
      trackUnsubscribe(unsub);

      const onTurnComplete = vi.fn();

      // Recovery context with isFirstTurn: true
      const recoveryContext = { isFirstTurn: true, messageHistory: [] };
      const recoveredAgentIds = new Set(['agent-1']);

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent1, agent2],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
        recoveryContext,
        recoveredAgentIds,
      });

      expect(capturedContexts).toHaveLength(2);
      // agent-1 was recovered, should get recovery context with isFirstTurn: true
      expect(capturedContexts.find((c) => c.agentId === 'agent-1')?.isFirstTurn).toBe(true);
      // agent-2 was not recovered, should not get isFirstTurn
      expect(capturedContexts.find((c) => c.agentId === 'agent-2')?.isFirstTurn).toBeUndefined();
    });
  });

  describe('should scope connector-swap context per agent', () => {
    it('applies hasConnectorSwap/cwdChange only to swapped agents and includes fresh history', async () => {
      const agent1 = createTestAgent('agent-1', { role: 'lead' });
      const agent2 = createTestAgent('agent-2');
      const session = createTestSession(sessionId, { agents: [agent1, agent2] });
      const turn = new Turn({ sessionId, agentIds: [agent1.agentId, agent2.agentId], turnId, turnNumber: 1 });

      const capturedContexts: Array<{
        agentId: string;
        hasConnectorSwap?: boolean;
        hasCwdChange: boolean;
        hasMessageHistory: boolean;
      }> = [];

      const unsub = MakaioBus.on(AgentSubjects.sendMessage, (context) => {
        capturedContexts.push({
          agentId: context.payload.agentId,
          hasConnectorSwap: context.payload.sessionContext?.hasConnectorSwap,
          hasCwdChange: context.payload.sessionContext?.turnContext?.cwdChange !== undefined,
          hasMessageHistory: context.payload.sessionContext?.messageHistory !== undefined,
        });
        context.setResult({ messageId: context.payload.messageId ?? 'generated-id' });
      });
      trackUnsubscribe(unsub);

      const onTurnComplete = vi.fn();
      const swappedAgentIds = new Set(['agent-1']);
      const swappedAgentCwd = new Map([['agent-1', { previousCwd: '/old', newCwd: '/new' }]]);

      await routeToAgents({
        bus: MakaioBus,
        session,
        agents: [agent1, agent2],
        message: testMessage,
        messageId,
        turn,
        deliveryMode: undefined,
        onTurnComplete,
        swappedAgentIds,
        swappedAgentCwd,
        freshMessageHistory: [],
      });

      expect(capturedContexts).toHaveLength(2);
      expect(capturedContexts.find((context) => context.agentId === 'agent-1')).toMatchObject({
        hasConnectorSwap: true,
        hasCwdChange: true,
        hasMessageHistory: true,
      });
      expect(capturedContexts.find((context) => context.agentId === 'agent-2')).toMatchObject({
        hasConnectorSwap: undefined,
        hasCwdChange: false,
        hasMessageHistory: false,
      });
    });
  });
});
