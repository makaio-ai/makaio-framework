/**
 * SessionOrchestrator tests - Auto-attach flow.
 *
 * Tests the automatic session creation and agent attachment when
 * sendMessage is called with a sessionId that does not exist or to a session with no agents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';
import { buildDeterministicAdapterId } from '../../adapter-runtime/index.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import {
  createMockSession,
  resetBusHandlers,
  waitForAsync,
  registerCreateSessionHandler,
  registerGetSessionHandler,
  registerGetAgentHandler,
  registerAgentAddedHandler,
  registerStartAgentHandler,
  registerSendMessageHandler,
  registerRehydrateAgentHandler,
  registerCwdChangeHandler,
  registerModelChangeHandler,
  emitAgentAdded,
  emitAdapterInitialized,
  collectTurnStartedEvents,
  collectUserMessageSentEvents,
  collectUserMessageAcknowledgedEvents,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';

describe('SessionOrchestrator - Auto-attach', () => {
  let orchestrator: SessionOrchestrator;
  let unsubscribers: UnsubscribeFunction[];
  let sessions: Map<string, IMakaioSession>;
  let defaultCwdChangeUnsub: UnsubscribeFunction | undefined;
  let defaultModelChangeUnsub: UnsubscribeFunction | undefined;

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    sessions = new Map();

    // Register default handlers
    unsubscribers.push(registerCreateSessionHandler(sessions));
    unsubscribers.push(registerGetSessionHandler(sessions));
    unsubscribers.push(registerAgentAddedHandler(sessions));
    unsubscribers.push(registerRehydrateAgentHandler());
    defaultCwdChangeUnsub = registerCwdChangeHandler();
    defaultModelChangeUnsub = registerModelChangeHandler();
    unsubscribers.push(defaultCwdChangeUnsub);
    unsubscribers.push(defaultModelChangeUnsub);
    unsubscribers.push(registerMockStorageHandlers());
  });

  afterEach(() => {
    orchestrator?.destroy();
    unsubscribers.forEach((unsub) => unsub());
  });

  describe('should create session when sendMessage called with new sessionId', () => {
    it('creates a new session and returns the provided sessionId', async () => {
      // Setup: register handlers for auto-attach flow
      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      // Execute
      const sessionId = `session-${crypto.randomUUID().slice(0, 8)}`;
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello, world!',
      });

      // Assert
      expect(result.sessionId).toBe(sessionId);
      expect(result.messageId).toBeDefined();
      expect(result.turnId).toBeDefined();
    });
  });

  describe('should auto-attach agent when session has no agents', () => {
    it('calls adapter.startAgent when session exists but has no agents', async () => {
      // Setup: session with no agents
      const sessionId = 'session-empty';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      let startAgentCalled = false;
      let receivedPayload: { adapterId: string; sessionId: string } | undefined;

      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          startAgentCalled = true;
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('my-adapter');

      // Execute
      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'my-adapter' },
        message: 'Hello!',
      });

      // Assert
      expect(startAgentCalled).toBe(true);
      expect(receivedPayload).toEqual({
        adapterId: buildDeterministicAdapterId('test-machine', 'my-adapter'),
        sessionId,
      });
    });

    it('backfills adapterName from adapterId when the direct selection omits adapterName', async () => {
      const sessionId = 'session-id-only';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      let startAgentCalled = false;
      let receivedPayload: { adapterId: string; sessionId: string } | undefined;
      unsubscribers.push(
        registerStartAgentHandler((payload) => {
          startAgentCalled = true;
          receivedPayload = { adapterId: payload.adapterId, sessionId: payload.sessionId };
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('resolved-adapter-name', 'machine-1:resolved-adapter-name');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterId: 'machine-1:resolved-adapter-name' },
        message: 'Hello!',
      });

      expect(startAgentCalled).toBe(true);
      expect(receivedPayload).toEqual({
        adapterId: 'machine-1:resolved-adapter-name',
        sessionId,
      });
    });

    it('rejects when explicit adapterName does not match the name stored for adapterId', async () => {
      const sessionId = 'session-name-id-mismatch';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('bar', 'machine-1:bar');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId,
          agent: { kind: 'adapter', adapterName: 'foo', adapterId: 'machine-1:bar' },
          message: 'Hello!',
        }),
      ).rejects.toThrow(/adapterName "foo" does not match adapterId "machine-1:bar"/);
    });
  });

  describe('should require agent selection when auto-attaching', () => {
    it('throws error when agent selection is missing for session with no agents', async () => {
      // Setup: session with no agents
      const sessionId = 'session-no-adapter';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      // Execute & Assert — framework orchestrator requires an explicit initial agent selection.
      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId,
          message: 'Hello!',
          // No agent selection provided
        }),
      ).rejects.toThrow(/agent selection required/);
    });

    it('throws error when agent selection is missing for new session', async () => {
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      // Execute & Assert — framework orchestrator requires an explicit initial agent selection.
      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId: `session-${crypto.randomUUID().slice(0, 8)}`,
          message: 'Hello!',
          // No agent selection
        }),
      ).rejects.toThrow(/agent selection required/);
    });
  });

  describe('should emit turn.started for auto-attach flow', () => {
    it('emits turn.started event with correct agentIds', async () => {
      const sessionId = 'session-turn-started';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());

      const turnStarted = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      await waitForAsync();

      // Assert
      expect(turnStarted.received).toHaveLength(1);
      expect(turnStarted.received[0]).toMatchObject({
        sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
      });
      expect(turnStarted.received[0].agentIds).toHaveLength(1);
    });
  });

  describe('should emit user_message.sent for auto-attach flow', () => {
    it('emits user_message.sent event with message content', async () => {
      const sessionId = 'session-msg-sent';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());

      const messageSent = collectUserMessageSentEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      const testMessage = 'Test message content';

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: testMessage,
      });

      await waitForAsync();

      // Assert
      expect(messageSent.received).toHaveLength(1);
      expect(messageSent.received[0]).toMatchObject({
        sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
        content: testMessage,
      });
      expect(messageSent.received[0].agentIds).toHaveLength(1);
    });
  });

  describe('should emit user_message.acknowledged for auto-attach flow', () => {
    it('emits user_message.acknowledged event after agent receives message', async () => {
      const sessionId = 'session-msg-ack';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());
      unsubscribers.push(registerSendMessageHandler());

      const messageAck = collectUserMessageAcknowledgedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      await waitForAsync();

      // Assert
      expect(messageAck.received).toHaveLength(1);
      expect(messageAck.received[0]).toMatchObject({
        sessionId,
        turnId: result.turnId,
        messageId: result.messageId,
      });
      expect(messageAck.received[0].agentId).toBeDefined();
    });
  });

  describe('should return sessionId, messageId, turnId', () => {
    it('returns all three IDs for auto-attach flow', async () => {
      const sessionId = 'session-return-ids';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      // Execute
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      // Assert
      expect(result.sessionId).toBe(sessionId);
      expect(result.messageId).toBeDefined();
      expect(result.messageId).toBeTruthy();
      expect(result.turnId).toBeDefined();
      expect(result.turnId).toBeTruthy();
    });

    it('returns provided sessionId for new session', async () => {
      unsubscribers.push(registerStartAgentHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      // Execute
      const sessionId = `session-${crypto.randomUUID().slice(0, 8)}`;
      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: { kind: 'adapter', adapterName: 'test-adapter' },
        message: 'Hello!',
      });

      // Assert
      expect(result.sessionId).toBe(sessionId);
      expect(result.messageId).toBeDefined();
      expect(result.turnId).toBeDefined();
    });

    it('passes runtime options to adapter.startAgent', async () => {
      const sessionId = 'session-runtime-opts';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));

      let receivedPayload: Record<string, unknown> | undefined;

      // Override the default startAgent handler to capture the full payload
      unsubscribers.push(
        MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
          receivedPayload = ctx.payload as Record<string, unknown>;
          const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
          const messageId = `msg-${crypto.randomUUID().slice(0, 8)}`;
          const adapterSessionId = `adapter-session-${sessionId}`;
          ctx.setResult({
            success: true as const,
            agentId,
            adapterId: ctx.payload.adapterId,
            adapterSessionId,
            sessionId,
            messageId,
          });

          // Emit agent.added event (mimics AIAdapter behavior)
          emitAgentAdded({ sessionId, agentId, adapterId: ctx.payload.adapterId, adapterSessionId });
        }),
      );

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      // Execute
      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName: 'test-adapter',
          model: 'claude-3-opus',
          cwd: '/home/user/project',
        },
        message: 'Hello!',
      });

      // Assert - runtime options should be passed to startAgent
      expect(receivedPayload).toBeDefined();
      expect(receivedPayload?.model).toBe('claude-3-opus');
      expect(receivedPayload?.cwd).toBe('/home/user/project');
    });

    it('does not run redundant model/cwd mutations after initial auto-attach', async () => {
      const sessionId = 'session-runtime-no-redundant-mutations';
      sessions.set(sessionId, createMockSession({ sessionId, agents: [] }));
      unsubscribers.push(registerGetAgentHandler(sessions));

      // Remove default handlers to count exactly how many mutation RPCs are attempted.
      defaultCwdChangeUnsub?.();
      defaultModelChangeUnsub?.();

      let modelChangeCalls = 0;
      let cwdChangeCalls = 0;
      unsubscribers.push(
        MakaioBus.on(AgentSubjects.model.change, (ctx) => {
          modelChangeCalls += 1;
          ctx.setResult({ success: true, swapped: false });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(AgentSubjects.cwd.change, (ctx) => {
          cwdChangeCalls += 1;
          ctx.setResult({ success: true, previousCwd: '/previous/cwd' });
        }),
      );
      unsubscribers.push(registerStartAgentHandler());
      unsubscribers.push(registerSendMessageHandler());

      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');
      await emitAdapterInitialized('test-adapter');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        agent: {
          kind: 'adapter',
          adapterName: 'test-adapter',
          model: 'claude-3-opus',
          cwd: '/home/user/project',
        },
        message: 'Hello!',
      });

      expect(modelChangeCalls).toBe(0);
      expect(cwdChangeCalls).toBe(0);
    });
  });
});
