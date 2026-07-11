/**
 * SessionOrchestrator tests - Turn lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession } from '@makaio/contracts';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { SessionBridge } from '../session-bridge.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR } from '../session-turn-manager.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import { TurnStorageSubjects } from '../turns/index.js';
import {
  createMockSession,
  createMockAgent,
  resetBusHandlers,
  waitForAsync,
  registerGetSessionHandler,
  registerGetAgentHandler,
  registerSendMessageHandler,
  collectTurnStartedEvents,
  collectTurnCompletedEvents,
  collectUserMessageCompletedEvents,
  emitAgentComplete,
  emitAgentError,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';

describe('SessionOrchestrator - Turns', () => {
  let orchestrator: SessionOrchestrator;
  let bridge: SessionBridge;
  let unsubscribers: UnsubscribeFunction[];
  let sessions: Map<string, IMakaioSession>;

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    sessions = new Map();
    unsubscribers.push(registerGetSessionHandler(sessions));
    unsubscribers.push(registerGetAgentHandler(sessions));
    unsubscribers.push(registerMockStorageHandlers());
    bridge = new SessionBridge(MakaioBus);
  });

  afterEach(() => {
    orchestrator?.destroy();
    bridge?.destroy();
    unsubscribers.forEach((u) => u());
  });

  const setupSession = (id: string, agents: ReturnType<typeof createMockAgent>[], leadId: string) => {
    sessions.set(id, createMockSession({ sessionId: id, agents, leadAgentId: leadId }));
  };

  describe('should create turn on first message', () => {
    it('creates new turn with UUID format', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const result = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Hi' });
      expect(result.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('discards a newly created active turn when user-message append fails', async () => {
      bridge.destroy();
      resetBusHandlers();
      bridge = new SessionBridge(MakaioBus);
      unsubscribers = [];
      sessions = new Map();
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerGetSessionHandler(sessions));
      unsubscribers.push(registerGetAgentHandler(sessions));

      const createdTurnIds: string[] = [];
      const turnStatuses = new Map<string, { status: 'active' | 'completed' | 'error'; error?: string }>();
      const buildCompletedTurnResult = (turnId: string) => {
        const stored = turnStatuses.get(turnId);
        if (!stored) throw new Error(`turn ${turnId} not created`);
        return {
          turnId,
          sessionId: 's1',
          turnNumber: createdTurnIds.indexOf(turnId) + 1,
          startedAt: Date.now(),
          status: stored.status,
          error: stored.error,
        };
      };
      let shouldFailAppend = true;
      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.create, (ctx) => {
          const turnId = ctx.payload.turnId ?? crypto.randomUUID();
          createdTurnIds.push(turnId);
          turnStatuses.set(turnId, { status: 'active' });
          ctx.setResult({
            turn: {
              turnId,
              sessionId: ctx.payload.sessionId,
              turnNumber: createdTurnIds.length,
              startedAt: Date.now(),
              status: 'active',
            },
          });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
          const stored = turnStatuses.get(ctx.payload.turnId);
          if (!stored) throw new Error(`turn ${ctx.payload.turnId} not created`);
          if (ctx.payload.expectedStatus && stored.status !== ctx.payload.expectedStatus) {
            ctx.setResult({
              turn: buildCompletedTurnResult(ctx.payload.turnId),
              transitioned: false,
            });
            return;
          }
          turnStatuses.set(ctx.payload.turnId, { status: ctx.payload.status, error: ctx.payload.error });
          ctx.setResult({
            turn: {
              ...buildCompletedTurnResult(ctx.payload.turnId),
              completedAt: Date.now(),
            },
            transitioned: true,
          });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(MessageStorageSubjects.append, (ctx) => {
          if (shouldFailAppend) {
            throw new Error('append unavailable');
          }
          ctx.setResult({
            message: {
              ...ctx.payload.message,
              messageId: ctx.payload.message.messageId ?? crypto.randomUUID(),
              editOf: undefined,
            },
          });
        }),
      );
      unsubscribers.push(registerSendMessageHandler());
      const startedEvents = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'First' }),
      ).rejects.toThrow('append unavailable');
      shouldFailAppend = false;

      const retry = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Retry' });
      await waitForAsync();

      expect(createdTurnIds).toHaveLength(2);
      expect(turnStatuses.get(createdTurnIds[0])).toEqual({
        status: 'error',
        error: USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR,
      });
      expect(retry.turnId).toBe(createdTurnIds[1]);
      expect(startedEvents.received).toHaveLength(1);
      expect(startedEvents.received[0].turnId).toBe(retry.turnId);
    });

    it('fails setup when user-message append storage is unhandled', async () => {
      bridge.destroy();
      resetBusHandlers();
      bridge = new SessionBridge(MakaioBus);
      unsubscribers = [];
      sessions = new Map();
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerGetSessionHandler(sessions));
      unsubscribers.push(registerGetAgentHandler(sessions));

      let createdTurnId = '';
      let completedStatus: { status: 'completed' | 'error'; error?: string } | undefined;
      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.create, (ctx) => {
          createdTurnId = ctx.payload.turnId ?? crypto.randomUUID();
          ctx.setResult({
            turn: {
              turnId: createdTurnId,
              sessionId: ctx.payload.sessionId,
              turnNumber: 1,
              startedAt: Date.now(),
              status: 'active',
            },
          });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
          completedStatus = { status: ctx.payload.status, error: ctx.payload.error };
          ctx.setResult({
            turn: {
              turnId: ctx.payload.turnId,
              sessionId: 's1',
              turnNumber: 1,
              startedAt: Date.now(),
              completedAt: Date.now(),
              status: ctx.payload.status,
              error: ctx.payload.error,
            },
            transitioned: true,
          });
        }),
      );
      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'First' }),
      ).rejects.toThrow('Message storage append handler is not registered');

      expect(createdTurnId).not.toBe('');
      expect(completedStatus).toEqual({
        status: 'error',
        error: USER_MESSAGE_PERSISTENCE_FAILED_TURN_ERROR,
      });
    });

    it('makes a joiner reacquire only after failed first-message preparation settles', async () => {
      bridge.destroy();
      resetBusHandlers();
      bridge = new SessionBridge(MakaioBus);
      unsubscribers = [];
      sessions = new Map();
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerGetSessionHandler(sessions));
      unsubscribers.push(registerGetAgentHandler(sessions));

      const createdTurnIds: string[] = [];
      const completeCalls: string[] = [];
      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.create, (ctx) => {
          const turnId = ctx.payload.turnId ?? crypto.randomUUID();
          createdTurnIds.push(turnId);
          ctx.setResult({
            turn: {
              turnId,
              sessionId: ctx.payload.sessionId,
              turnNumber: createdTurnIds.length,
              startedAt: Date.now(),
              status: 'active',
            },
          });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.complete, (ctx) => {
          completeCalls.push(ctx.payload.turnId);
          ctx.setResult({
            turn: {
              turnId: ctx.payload.turnId,
              sessionId: 's1',
              turnNumber: createdTurnIds.indexOf(ctx.payload.turnId) + 1,
              startedAt: Date.now(),
              completedAt: Date.now(),
              status: ctx.payload.status,
              error: ctx.payload.error,
            },
            transitioned: true,
          });
        }),
      );

      let markFirstAppendStarted!: () => void;
      const firstAppendStarted = new Promise<void>((resolve) => {
        markFirstAppendStarted = resolve;
      });
      let failFirstAppend!: () => void;
      const firstAppendGate = new Promise<void>((_, reject) => {
        failFirstAppend = () => reject(new Error('first append unavailable'));
      });
      let markSecondAppendStarted!: () => void;
      const secondAppendStarted = new Promise<void>((resolve) => {
        markSecondAppendStarted = resolve;
      });
      let resolveSecondAppend!: () => void;
      const secondAppendGate = new Promise<void>((resolve) => {
        resolveSecondAppend = resolve;
      });

      unsubscribers.push(
        MakaioBus.on(MessageStorageSubjects.append, async (ctx) => {
          if (ctx.payload.message.contentText === 'First') {
            markFirstAppendStarted();
            await firstAppendGate;
          }
          if (ctx.payload.message.contentText === 'Second') {
            markSecondAppendStarted();
            await secondAppendGate;
          }
          ctx.setResult({
            message: {
              ...ctx.payload.message,
              messageId: ctx.payload.message.messageId ?? crypto.randomUUID(),
              editOf: undefined,
            },
          });
        }),
      );
      unsubscribers.push(registerSendMessageHandler());
      const startedEvents = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const firstSend = MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'First' });
      await firstAppendStarted;
      const secondSend = MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Second' });

      failFirstAppend();
      await expect(firstSend).rejects.toThrow('first append unavailable');
      await secondAppendStarted;
      expect(completeCalls).toHaveLength(1);

      resolveSecondAppend();
      const secondResult = await secondSend;
      await waitForAsync();

      expect(createdTurnIds).toHaveLength(2);
      expect(secondResult.turnId).toBe(createdTurnIds[1]);
      expect(startedEvents.received).toHaveLength(1);
      expect(startedEvents.received[0].messageId).toBe(secondResult.messageId);
    });

    it('preserves the user-message append error when failed-turn cleanup also fails', async () => {
      bridge.destroy();
      resetBusHandlers();
      bridge = new SessionBridge(MakaioBus);
      unsubscribers = [];
      sessions = new Map();
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerGetSessionHandler(sessions));
      unsubscribers.push(registerGetAgentHandler(sessions));

      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.create, (ctx) => {
          ctx.setResult({
            turn: {
              turnId: ctx.payload.turnId ?? crypto.randomUUID(),
              sessionId: ctx.payload.sessionId,
              turnNumber: 1,
              startedAt: Date.now(),
              status: 'active',
            },
          });
        }),
      );
      unsubscribers.push(
        MakaioBus.on(MessageStorageSubjects.append, () => {
          throw new Error('append unavailable');
        }),
      );
      unsubscribers.push(
        MakaioBus.on(TurnStorageSubjects.complete, () => {
          throw new Error('turn completion unavailable');
        }),
      );
      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'First' }),
      ).rejects.toThrow('append unavailable');
    });
  });

  describe('should emit turn.started with agentIds', () => {
    it('emits event with participating agents', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2')], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId: 's1',
        message: 'Hi',
        agentIds: 'all',
      });
      await waitForAsync();

      expect(events.received).toHaveLength(1);
      expect(events.received[0]).toMatchObject({ sessionId: 's1', turnId: result.turnId });
      expect(events.received[0].agentIds).toContain('a1');
      expect(events.received[0].agentIds).toContain('a2');
    });

    it('includes only targeted agents', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2'), createMockAgent('a3')], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Hi', agentIds: ['a1', 'a3'] });
      await waitForAsync();

      expect(events.received[0].agentIds).toHaveLength(2);
      expect(events.received[0].agentIds).not.toContain('a2');
    });

    it('propagates extension initiator metadata to turn events', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const startedEvents = collectTurnStartedEvents(unsubscribers);
      const completedEvents = collectTurnCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId: 's1',
        message: 'Run routine output',
        source: 'extension',
        extensionId: 'routine:validation',
      });
      await emitAgentComplete({ agentId: 'a1', messageId: result.messageId, turnId: result.turnId });
      await waitForAsync();

      expect(startedEvents.received).toHaveLength(1);
      expect(startedEvents.received[0].initiator).toEqual({
        source: 'extension',
        sourceId: 'routine:validation',
      });

      expect(completedEvents.received).toHaveLength(1);
      expect(completedEvents.received[0].initiator).toEqual({
        source: 'extension',
        sourceId: 'routine:validation',
      });
    });

    it('rejects extension source without extensionId', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await expect(
        MakaioBus.request(SessionSubjects.sendMessage, {
          sessionId: 's1',
          message: 'Run routine output',
          source: 'extension',
        }),
      ).rejects.toThrow('extensionId is required when source is "extension"');
    });
  });

  describe('should reuse active turn for subsequent messages', () => {
    it('uses same turnId, different messageIds', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const r1 = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'First' });
      const r2 = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Second' });

      expect(r1.turnId).toBe(r2.turnId);
      expect(r1.messageId).not.toBe(r2.messageId);
    });

    it('emits turn.started only once', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnStartedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'First' });
      await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Second' });
      await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Third' });
      await waitForAsync();

      expect(events.received).toHaveLength(1);
    });
  });

  describe('should track multiple messages within turn', () => {
    it('generates unique messageIds for each message', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: `Msg ${i}` });
        ids.push(r.messageId);
      }
      expect(new Set(ids).size).toBe(5);
    });
  });

  describe('should complete turn when single agent completes', () => {
    it('emits turn.completed after agent.complete', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const r = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Hi' });
      await emitAgentComplete({ agentId: 'a1', messageId: r.messageId, turnId: r.turnId });
      await waitForAsync();

      expect(events.received).toHaveLength(1);
      expect(events.received[0]).toMatchObject({ sessionId: 's1', turnId: r.turnId, success: true });
    });
  });

  describe('should complete turn when all agents complete (multi-agent)', () => {
    it('waits for all agents', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2')], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const r = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId: 's1',
        message: 'Hi',
        agentIds: 'all',
      });

      await emitAgentComplete({ agentId: 'a1', messageId: r.messageId, turnId: r.turnId });
      await waitForAsync();
      expect(events.received).toHaveLength(0);

      await emitAgentComplete({ agentId: 'a2', messageId: r.messageId, turnId: r.turnId });
      await waitForAsync();
      expect(events.received).toHaveLength(1);
      expect(events.received[0].success).toBe(true);
    });
  });

  describe('should emit turn.completed with success on all success', () => {
    it('reports success for 3 agents completing', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2'), createMockAgent('a3')], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const r = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId: 's1',
        message: 'Hi',
        agentIds: 'all',
      });
      await emitAgentComplete({ agentId: 'a1', messageId: r.messageId, turnId: r.turnId });
      await emitAgentComplete({ agentId: 'a2', messageId: r.messageId, turnId: r.turnId });
      await emitAgentComplete({ agentId: 'a3', messageId: r.messageId, turnId: r.turnId });
      await waitForAsync();

      expect(events.received).toHaveLength(1);
      expect(events.received[0].success).toBe(true);
      expect(events.received[0].error).toBeUndefined();
    });
  });

  describe('should emit turn.completed with error on any agent error', () => {
    it('reports error when one agent fails', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2')], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const r = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId: 's1',
        message: 'Hi',
        agentIds: 'all',
      });
      await emitAgentComplete({ agentId: 'a1', messageId: r.messageId, turnId: r.turnId });
      await emitAgentError({ agentId: 'a2', error: 'Failure', messageId: r.messageId, turnId: r.turnId });
      await waitForAsync();

      expect(events.received).toHaveLength(1);
      expect(events.received[0].success).toBe(false);
      expect(events.received[0].error).toContain('Failure');
    });

    it('aggregates multiple errors', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2')], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectTurnCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const result = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId: 's1',
        message: 'Hi',
        agentIds: 'all',
      });
      await emitAgentError({ agentId: 'a1', error: 'Err1', messageId: result.messageId, turnId: result.turnId });
      await emitAgentError({ agentId: 'a2', error: 'Err2', messageId: result.messageId, turnId: result.turnId });
      await waitForAsync();

      expect(events.received[0].success).toBe(false);
      expect(events.received[0].error).toContain('Err1');
      expect(events.received[0].error).toContain('Err2');
    });
  });

  describe('should emit user_message.completed per agent completion', () => {
    it('emits per-agent completion events', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2')], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectUserMessageCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const r = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId: 's1',
        message: 'Hi',
        agentIds: 'all',
      });

      await emitAgentComplete({ agentId: 'a1', messageId: r.messageId, turnId: r.turnId });
      await waitForAsync();
      expect(events.received).toHaveLength(1);
      expect(events.received[0]).toMatchObject({ sessionId: 's1', agentId: 'a1', outcome: 'completed' });

      await emitAgentComplete({ agentId: 'a2', messageId: r.messageId, turnId: r.turnId });
      await waitForAsync();
      expect(events.received).toHaveLength(2);
      expect(events.received[1].agentId).toBe('a2');
    });

    it('includes error for failed agent', async () => {
      setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');
      unsubscribers.push(registerSendMessageHandler());
      const events = collectUserMessageCompletedEvents(unsubscribers);
      orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

      const result = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's1', message: 'Hi' });
      await emitAgentError({ agentId: 'a1', error: 'Failed', messageId: result.messageId, turnId: result.turnId });
      await waitForAsync();

      expect(events.received).toHaveLength(1);
      expect(events.received[0]).toMatchObject({ sessionId: 's1', agentId: 'a1', outcome: 'error', error: 'Failed' });
    });
  });
});
