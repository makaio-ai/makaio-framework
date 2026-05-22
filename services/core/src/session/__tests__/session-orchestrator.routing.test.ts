/**
 * SessionOrchestrator tests - Message routing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import {
  createMockSession,
  createMockAgent,
  resetBusHandlers,
  waitForAsync,
  registerGetSessionHandler,
  registerGetAgentHandler,
  registerCreateSessionHandler,
  registerSendMessageHandler,
  collectUserMessageSentEvents,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';

describe('SessionOrchestrator - Routing', () => {
  let orchestrator: SessionOrchestrator;
  let unsubscribers: UnsubscribeFunction[];
  let sessions: Map<string, IMakaioSession>;

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    sessions = new Map();
    unsubscribers.push(registerGetSessionHandler(sessions));
    unsubscribers.push(registerCreateSessionHandler(sessions));
    unsubscribers.push(registerGetAgentHandler(sessions));
    unsubscribers.push(registerMockStorageHandlers());
  });

  afterEach(() => {
    orchestrator?.destroy();
    unsubscribers.forEach((unsub) => unsub());
  });

  /**
   * Adds a session to the map, registers a send handler that captures agentIds,
   * and creates the orchestrator. Reduces boilerplate in routing tests.
   * @param sessionId - Session ID
   * @param session - Session to register
   * @returns Array that captures sent agentIds
   */
  function setupRoutingTest(sessionId: string, session: IMakaioSession): string[] {
    sessions.set(sessionId, session);
    const sentToAgents: string[] = [];
    unsubscribers.push(registerSendMessageHandler((p) => sentToAgents.push(p.agentId)));
    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
    return sentToAgents;
  }

  describe('should route message to lead agent by default', () => {
    it('sends message only to lead agent when agentIds not specified', async () => {
      const sessionId = 'session-lead';
      const sentToAgents = setupRoutingTest(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-lead', { role: 'lead' }), createMockAgent('agent-member')],
          leadAgentId: 'agent-lead',
        }),
      );

      await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'Hello!' });
      await waitForAsync();

      expect(sentToAgents).toEqual(['agent-lead']);
    });

    it('forwards responseSchema to agent.sendMessage', async () => {
      const sessionId = 'session-response-schema';
      const responseSchema = { type: 'object', properties: { answer: { type: 'string' } } };
      let capturedResponseSchema: Record<string, unknown> | undefined;
      sessions.set(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-lead', { role: 'lead' })],
          leadAgentId: 'agent-lead',
        }),
      );
      unsubscribers.push(
        registerSendMessageHandler((payload) => {
          capturedResponseSchema = payload.responseSchema;
        }),
      );
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'Hello!', responseSchema });
      await waitForAsync();

      expect(capturedResponseSchema).toEqual(responseSchema);
    });

    it('throws error when lead agent not found', async () => {
      const sessionId = 'session-no-lead';
      sessions.set(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-member')],
          leadAgentId: 'nonexistent-lead',
        }),
      );

      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'Hello!' })).rejects.toThrow(
        'Lead agent not found',
      );
    });
  });

  describe('should route message to specific agentIds when provided', () => {
    it('sends message to specified agents only', async () => {
      const sessionId = 'session-specific';
      const sentToAgents = setupRoutingTest(
        sessionId,
        createMockSession({
          sessionId,
          agents: [
            createMockAgent('agent-1', { role: 'lead' }),
            createMockAgent('agent-2'),
            createMockAgent('agent-3'),
          ],
          leadAgentId: 'agent-1',
        }),
      );

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'Hello!',
        agentIds: ['agent-2', 'agent-3'],
      });
      await waitForAsync();

      expect(sentToAgents).toHaveLength(2);
      expect(sentToAgents).toContain('agent-2');
      expect(sentToAgents).toContain('agent-3');
      expect(sentToAgents).not.toContain('agent-1');
    });
  });

  describe('should route message to all agents when agentIds is "all"', () => {
    it('broadcasts message to all agents in session', async () => {
      const sessionId = 'session-broadcast';
      const sentToAgents = setupRoutingTest(
        sessionId,
        createMockSession({
          sessionId,
          agents: [
            createMockAgent('agent-1', { role: 'lead' }),
            createMockAgent('agent-2'),
            createMockAgent('agent-3'),
          ],
          leadAgentId: 'agent-1',
        }),
      );

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'Hello!',
        agentIds: 'all',
      });
      await waitForAsync();

      expect(sentToAgents).toHaveLength(3);
      expect(sentToAgents).toContain('agent-1');
      expect(sentToAgents).toContain('agent-2');
      expect(sentToAgents).toContain('agent-3');
    });
  });

  describe('should silently drop invalid agentIds from target list', () => {
    it('filters out non-existent agent IDs and routes to valid ones', async () => {
      const sessionId = 'session-invalid-ids';
      const sentToAgents = setupRoutingTest(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-1', { role: 'lead' }), createMockAgent('agent-2')],
          leadAgentId: 'agent-1',
        }),
      );

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'Hello!',
        agentIds: ['agent-1', 'nonexistent-agent', 'agent-2'],
      });
      await waitForAsync();

      expect(sentToAgents).toHaveLength(2);
      expect(sentToAgents).toContain('agent-1');
      expect(sentToAgents).toContain('agent-2');
    });
  });

  describe('should reject only when ALL target agentIds are invalid', () => {
    it('throws error when all specified agent IDs are invalid', async () => {
      const sessionId = 'session-all-invalid';
      sessions.set(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-1', { role: 'lead' })],
          leadAgentId: 'agent-1',
        }),
      );

      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId,
          message: 'Hello!',
          agentIds: ['invalid-1', 'invalid-2'],
        }),
      ).rejects.toThrow('No valid target agents found');
    });

    it('succeeds when at least one agent ID is valid', async () => {
      const sessionId = 'session-one-valid';
      const sentToAgents = setupRoutingTest(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-1', { role: 'lead' })],
          leadAgentId: 'agent-1',
        }),
      );

      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'Hello!',
        agentIds: ['invalid-1', 'agent-1', 'invalid-2'],
      });
      await waitForAsync();

      expect(result.messageId).toBeDefined();
      expect(sentToAgents).toEqual(['agent-1']);
    });
  });

  describe('should reject message to closed session', () => {
    it('throws error when session is not active', async () => {
      const sessionId = 'session-closed';
      sessions.set(
        sessionId,
        createMockSession({
          sessionId,
          status: 'closed',
          agents: [createMockAgent('agent-1', { role: 'lead' })],
          leadAgentId: 'agent-1',
        }),
      );

      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'Hello!' })).rejects.toThrow(
        'Session is not active',
      );
    });

    it('throws error when session does not exist and agent selection is missing', async () => {
      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId: 'nonexistent-session',
          message: 'Hello!',
        }),
      ).rejects.toThrow(/agent selection required/);
    });
  });

  describe('should emit user_message.sent with content and resolved targets', () => {
    it('includes correct content and agentIds in event', async () => {
      const sessionId = 'session-msg-sent';
      sessions.set(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-1', { role: 'lead' }), createMockAgent('agent-2')],
          leadAgentId: 'agent-1',
        }),
      );

      unsubscribers.push(registerSendMessageHandler());
      const messageSent = collectUserMessageSentEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const testMessage = 'Test message content';
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: testMessage,
        agentIds: ['agent-1', 'agent-2'],
        origin: 'voice',
      });
      await waitForAsync();

      expect(messageSent.received).toHaveLength(1);
      expect(messageSent.received[0]).toMatchObject({
        sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
        content: testMessage,
        origin: 'voice',
      });
      expect(messageSent.received[0].agentIds).toContain('agent-1');
      expect(messageSent.received[0].agentIds).toContain('agent-2');
    });

    it('filters invalid agentIds from event', async () => {
      const sessionId = 'session-filtered-sent';
      sessions.set(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-1', { role: 'lead' })],
          leadAgentId: 'agent-1',
        }),
      );

      unsubscribers.push(registerSendMessageHandler());
      const messageSent = collectUserMessageSentEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'Test',
        agentIds: ['agent-1', 'invalid-agent'],
      });
      await waitForAsync();

      expect(messageSent.received).toHaveLength(1);
      expect(messageSent.received[0].agentIds).toEqual(['agent-1']);
    });
  });

  describe('recovery lock scoping', () => {
    it('isolates concurrent recovery by target agent set', async () => {
      const sessionId = 'session-recovery-lock-key';
      sessions.set(
        sessionId,
        createMockSession({
          sessionId,
          agents: [createMockAgent('agent-1', { role: 'lead' }), createMockAgent('agent-2')],
          leadAgentId: 'agent-1',
        }),
      );

      // Replace default fast getAgent handler so the first recovery attempt stays in-flight.
      unsubscribers[2]?.();
      unsubscribers[2] = MakaioBus.on(AdapterSubjects.getAgent, async (ctx) => {
        if (ctx.payload.agentId === 'agent-1') {
          await waitForAsync(25);
        }
        ctx.setResult({
          agent: {
            agentId: ctx.payload.agentId,
            sessionId,
            adapterSessionId: `adapter-session-${ctx.payload.agentId}`,
          },
        });
      });

      const sent: Array<{ agentId: string; message: string }> = [];
      unsubscribers.push(
        registerSendMessageHandler((payload) => {
          const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.message);
          sent.push({ agentId: payload.agentId, message });
        }),
      );
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const first = MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'to-agent-1',
        agentIds: ['agent-1'],
      });
      await waitForAsync(5);
      const second = MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'to-agent-2',
        agentIds: ['agent-2'],
      });

      await Promise.all([first, second]);

      expect(sent).toContainEqual({ agentId: 'agent-1', message: 'to-agent-1' });
      expect(sent).toContainEqual({ agentId: 'agent-2', message: 'to-agent-2' });
    });
  });
});
