import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { MessageInput } from '@makaio/contracts';
import {
  ATTACH_TEST_IDS,
  createAttachHandlerContext,
  registerSuccessfulMessageAppendHandler,
  registerSuccessfulSendHandler,
  type AttachHandlerTestContext,
} from './shared.js';
import { waitForAsync } from '../../__tests__/shared.js';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { SessionEventStorageSubjects } from '../../session-events/index.js';
import { TurnStorageSubjects } from '../../turns/index.js';
import { SessionBridge } from '../../session-bridge.js';

describe('registerAttachHandler - turn tracking', () => {
  const { sessionId, adapterName, agentId } = ATTACH_TEST_IDS;

  let ctx: AttachHandlerTestContext;
  let defaultMessageAppendCleanup: () => void;

  beforeEach(() => {
    ctx = createAttachHandlerContext();
    ctx.trackUnsubscribe(registerSuccessfulSendHandler());
    defaultMessageAppendCleanup = registerSuccessfulMessageAppendHandler({ priority: -100 });
    ctx.trackUnsubscribe(defaultMessageAppendCleanup);
  });

  afterEach(() => {
    ctx.destroy();
    vi.restoreAllMocks();
  });

  describe('should setup turn tracking when initialMessage provided', () => {
    it('creates an active Turn', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      const turn = ctx.getActiveTurn(sessionId);
      expect(turn).toBeDefined();
      expect(turn?.sessionId).toBe(sessionId);
      expect([...turn!.agentIds]).toContain(agentId);
      expect(result.turnId).toBe(turn?.turnId);
      expect(result.messageId).toMatch(/[0-9a-f-]{36}/);
    });

    it('routes the canonical initial turn through the real completion and persistence seam', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.turnManager.registerCompletionHandlers(ctx.turnManager.completeTurn.bind(ctx.turnManager));
      const bridge = new SessionBridge(MakaioBus);
      const appendedMessages: unknown[] = [];
      const turnCompleted: Array<{ turnId: string; success: boolean }> = [];
      const settlements: Array<{ turnId: string; agentId: string }> = [];
      let sendPayload: { messageId?: string; turnId?: string; sessionId?: string } | undefined;

      ctx.trackUnsubscribe(
        registerSuccessfulMessageAppendHandler({
          priority: 1,
          onAppend: ({ message }) => appendedMessages.push(message),
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(
          SessionSubjects.turn.completed,
          ({ payload }) => {
            turnCompleted.push({ turnId: payload.turnId, success: payload.success });
          },
          { priority: 1 },
        ),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.assistantPersistenceSettled, ({ payload }) => {
          settlements.push({ turnId: payload.turnId, agentId: payload.agentId });
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(
          AgentSubjects.sendMessage,
          async (context) => {
            sendPayload = context.payload;
            context.setResult({ messageId: context.payload.messageId ?? crypto.randomUUID() });
            await MakaioBus.emit(AgentSubjects.message, {
              agentId,
              adapterId: context.payload.adapterId,
              adapterName,
              adapterSessionId: 'native-session',
              messageId: context.payload.messageId ?? crypto.randomUUID(),
              content: 'Initial answer',
              turnId: context.payload.turnId,
            });
            await MakaioBus.emit(AgentSubjects.complete, {
              agentId,
              adapterId: context.payload.adapterId,
              adapterName,
              adapterSessionId: 'native-session',
              messageId: context.payload.messageId ?? crypto.randomUUID(),
              turnId: context.payload.turnId,
              outcome: 'completed',
            });
          },
          { priority: 1 },
        ),
      );
      ctx.trackUnsubscribe(ctx.registerHandler());

      try {
        const result = await MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          initialMessage: 'Hello, agent!',
        });
        await waitForAsync();

        expect(receivedRequests[0].initialMessage).toBeUndefined();
        expect(sendPayload).toMatchObject({
          messageId: result.messageId,
          turnId: result.turnId,
          sessionId,
        });
        expect(appendedMessages).toContainEqual(
          expect.objectContaining({
            role: 'assistant',
            turnId: result.turnId,
            contentText: 'Initial answer',
          }),
        );
        expect(settlements).toContainEqual({ turnId: result.turnId!, agentId });
        expect(turnCompleted).toContainEqual({ turnId: result.turnId!, success: true });
        expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
      } finally {
        bridge.destroy();
      }
    });

    it('terminalizes a pre-created turn when initial provider dispatch rejects', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      const stoppedAgents = recordStoppedAgents(ctx);
      const completed: Array<{ success: boolean; error?: string }> = [];
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.completed, ({ payload }) => {
          completed.push({ success: payload.success, error: payload.error });
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(
          AgentSubjects.sendMessage,
          () => {
            throw new Error('provider dispatch failed');
          },
          { priority: 1 },
        ),
      );
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          initialMessage: 'Hello, agent!',
        }),
      ).rejects.toThrow('provider dispatch failed');

      expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
      expect(stoppedAgents).toContainEqual(expect.objectContaining({ agentId }));
      expect(completed).toContainEqual(
        expect.objectContaining({ success: false, error: expect.stringContaining('provider dispatch failed') }),
      );
    });

    it.each([
      'turn.started',
      'user_message.sent',
    ] as const)('keeps a durable attach turn routable through normal completion when the %s observer rejects', async (failedObserver) => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.turnManager.registerCompletionHandlers(ctx.turnManager.completeTurn.bind(ctx.turnManager));
      const turnCompleted: Array<{ turnId: string; success: boolean }> = [];
      let observerCalls = 0;
      if (failedObserver === 'turn.started') {
        ctx.trackUnsubscribe(
          MakaioBus.on(SessionSubjects.turn.started, () => {
            observerCalls += 1;
            throw new Error('turn observer failed');
          }),
        );
      } else {
        ctx.trackUnsubscribe(
          MakaioBus.on(SessionSubjects.user_message.sent, () => {
            observerCalls += 1;
            throw new Error('message observer failed');
          }),
        );
      }
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.completed, ({ payload }) => {
          turnCompleted.push({ turnId: payload.turnId, success: payload.success });
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(
          AgentSubjects.sendMessage,
          async (context) => {
            context.setResult({ messageId: context.payload.messageId ?? crypto.randomUUID() });
            await MakaioBus.emit(AgentSubjects.complete, {
              agentId,
              adapterId: context.payload.adapterId,
              adapterName,
              adapterSessionId: 'native-session',
              messageId: context.payload.messageId ?? crypto.randomUUID(),
              turnId: context.payload.turnId,
              outcome: 'completed',
            });
          },
          { priority: 1 },
        ),
      );
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });
      await waitForAsync();

      expect(observerCalls).toBe(1);
      expect(turnCompleted).toContainEqual({ turnId: result.turnId!, success: true });
      expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
    });

    it('rejects a second initial-message attach before starting another agent for an active session turn', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'First message',
      });

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          initialMessage: 'Competing message',
        }),
      ).rejects.toThrow('routable or pending turn');
      expect(receivedRequests).toHaveLength(1);
    });

    it('allows an idle attach without consuming or replacing the active turn slot', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe, receivedRequests } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const first = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'First message',
      });
      const activeTurn = ctx.getActiveTurn(sessionId);

      const idle = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(idle.turnId).toBeUndefined();
      expect(receivedRequests).toHaveLength(2);
      expect(ctx.getActiveTurn(sessionId)).toBe(activeTurn);
      expect(activeTurn?.turnId).toBe(first.turnId);
    });

    it('retries an initial-message terminal completion after storage fails once, then stops the started agent', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      let completionAttempts = 0;
      const stoppedAgents = recordStoppedAgents(ctx);
      ctx.trackUnsubscribe(
        MakaioBus.on(TurnStorageSubjects.complete, (context) => {
          completionAttempts += 1;
          if (completionAttempts === 1) {
            throw new Error('temporary completion storage failure');
          }
          context.setResult({
            turn: {
              turnId: context.payload.turnId,
              sessionId,
              turnNumber: 1,
              startedAt: Date.now(),
              completedAt: Date.now(),
              status: context.payload.status,
              error: context.payload.error,
            },
            transitioned: true,
          });
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(
          AgentSubjects.sendMessage,
          () => {
            throw new Error('provider dispatch failed');
          },
          { priority: 1 },
        ),
      );
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          initialMessage: 'Hello, agent!',
        }),
      ).rejects.toThrow('temporary completion storage failure');

      expect(completionAttempts).toBe(2);
      expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
      expect(stoppedAgents).toHaveLength(1);
      expect(stoppedAgents[0]).toMatchObject({ agentId });
    });

    it('emits turn.started event', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const turnStartedEvents: Array<{
        sessionId: string;
        turnId: string;
        messageId: string;
        agentIds: string[];
      }> = [];

      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.started, ({ payload }) => {
          turnStartedEvents.push({
            sessionId: payload.sessionId,
            turnId: payload.turnId,
            messageId: payload.messageId,
            agentIds: payload.agentIds,
          });
        }),
      );

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      await waitForAsync();

      expect(turnStartedEvents).toHaveLength(1);
      expect(turnStartedEvents[0].sessionId).toBe(sessionId);
      expect(turnStartedEvents[0].messageId).toBe(result.messageId);
      expect(turnStartedEvents[0].agentIds).toContain(agentId);
    });

    it('persists the initial user message before emitting turn events', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);

      const lifecycleOrder: string[] = [];
      const appendedMessages: unknown[] = [];
      ctx.trackUnsubscribe(
        registerSuccessfulMessageAppendHandler({
          onAppend: ({ message }) => {
            lifecycleOrder.push('append');
            appendedMessages.push(message);
          },
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.started, () => {
          lifecycleOrder.push('turn.started');
        }),
      );
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      await waitForAsync();

      expect(lifecycleOrder).toEqual(['append', 'turn.started']);
      expect(appendedMessages[0]).toMatchObject({
        messageId: result.messageId,
        sessionId,
        role: 'user',
        contentText: 'Hello, agent!',
        blocks: [{ type: 'text', content: 'Hello, agent!' }],
      });
      expect(appendedMessages[0]).toHaveProperty('turnId');
    });

    it('does not register an active turn or emit turn events when initial message persistence fails', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);

      const turnStartedEvents = collectAttachTurnStartedEvents(ctx);
      const completedTurns = recordCompletedTurns(ctx, sessionId);
      const stoppedAgents = recordStoppedAgents(ctx);
      registerFailingInitialMessageAppend(ctx, 'append unavailable');
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          initialMessage: 'Hello, agent!',
        }),
      ).rejects.toThrow('append unavailable');

      await waitForAsync();

      expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
      expect(turnStartedEvents).toHaveLength(0);
      expect(completedTurns).toHaveLength(1);
      expect(completedTurns[0]).toMatchObject({
        status: 'error',
        expectedStatus: 'active',
        error: 'initial-message-persistence-failed',
      });
      expect(stoppedAgents).toHaveLength(1);
      expect(stoppedAgents[0]).toMatchObject({ agentId });
      expect(stoppedAgents[0].adapterId).toBeTruthy();
    });

    it('rolls back the turn and started agent when message storage is unhandled', async () => {
      defaultMessageAppendCleanup();
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      const stoppedAgents = recordStoppedAgents(ctx);
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          initialMessage: 'Hello, agent!',
        }),
      ).rejects.toThrow('Message storage append handler is not registered');

      expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
      expect(stoppedAgents).toHaveLength(1);
    });

    it('clears the active turn and rolls back the agent when turn-start persistence fails', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);

      const appendedMessages = recordSuccessfulInitialMessageAppends(ctx);
      const turnStartedEvents = collectAttachTurnStartedEvents(ctx);
      const stoppedAgents = recordStoppedAgents(ctx);
      registerFailingTurnStartedPersistence(ctx, 'session event unavailable');
      ctx.trackUnsubscribe(ctx.registerHandler());

      await expect(
        MakaioBus.request(SessionSubjects.agent.attach, {
          sessionId,
          agent: { kind: 'adapter', adapterName },
          initialMessage: 'Hello, agent!',
        }),
      ).rejects.toThrow('session event unavailable');

      await waitForAsync();

      expect(appendedMessages).toHaveLength(1);
      expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
      expect(turnStartedEvents).toHaveLength(0);
      expect(stoppedAgents).toHaveLength(1);
      expect(stoppedAgents[0]).toMatchObject({ agentId });
    });

    it('emits user_message.sent event', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const userMessageSentEvents: Array<{
        sessionId: string;
        turnId: string;
        messageId: string;
        content: MessageInput;
        agentIds: string[];
      }> = [];

      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.user_message.sent, ({ payload }) => {
          userMessageSentEvents.push({
            sessionId: payload.sessionId,
            turnId: payload.turnId,
            messageId: payload.messageId,
            content: payload.content,
            agentIds: payload.agentIds,
          });
        }),
      );

      const initialMessage = 'Hello, agent!';
      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage,
      });

      await waitForAsync();

      expect(userMessageSentEvents).toHaveLength(1);
      expect(userMessageSentEvents[0].sessionId).toBe(sessionId);
      expect(userMessageSentEvents[0].content).toBe(initialMessage);
      expect(userMessageSentEvents[0].agentIds).toContain(agentId);
    });

    it('emits user_message.acknowledged event', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const acknowledgedEvents: Array<{
        sessionId: string;
        turnId: string;
        messageId: string;
        agentId: string;
      }> = [];

      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.user_message.acknowledged, ({ payload }) => {
          acknowledgedEvents.push({
            sessionId: payload.sessionId,
            turnId: payload.turnId,
            messageId: payload.messageId,
            agentId: payload.agentId,
          });
        }),
      );

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      await waitForAsync();

      expect(acknowledgedEvents).toHaveLength(1);
      expect(acknowledgedEvents[0].sessionId).toBe(sessionId);
      expect(acknowledgedEvents[0].messageId).toBe(result.messageId);
      expect(acknowledgedEvents[0].agentId).toBe(agentId);
    });

    it('handles structured message input', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const userMessageSentEvents: Array<{ content: MessageInput }> = [];

      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.user_message.sent, ({ payload }) => {
          userMessageSentEvents.push({ content: payload.content });
        }),
      );

      const structuredMessage = {
        role: 'user' as const,
        blocks: [{ type: 'text' as const, content: 'Hello with blocks!' }],
      };

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: structuredMessage,
      });

      await waitForAsync();

      expect(userMessageSentEvents).toHaveLength(1);
      expect(userMessageSentEvents[0].content).toEqual(structuredMessage);
    });
  });

  describe('should NOT setup turn when no initialMessage', () => {
    it('does not create an active turn', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(ctx.getActiveTurn(sessionId)).toBeUndefined();
      expect(result.turnId).toBeUndefined();
      expect(result.messageId).toBeUndefined();
    });

    it('does not emit turn.started event', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const turnStartedEvents: unknown[] = [];
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.started, ({ payload }) => {
          turnStartedEvents.push(payload);
        }),
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      await waitForAsync();

      expect(turnStartedEvents).toHaveLength(0);
    });

    it('does not emit user_message events', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const userMessageEvents: unknown[] = [];
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.user_message.sent, ({ payload }) => {
          userMessageEvents.push(payload);
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.user_message.acknowledged, ({ payload }) => {
          userMessageEvents.push(payload);
        }),
      );

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      await waitForAsync();

      expect(userMessageEvents).toHaveLength(0);
    });
  });
});

/**
 * Register a failing initial-message append handler.
 * @param ctx - Attach test context owning cleanup
 * @param message - Error message to throw
 */
function registerFailingInitialMessageAppend(ctx: AttachHandlerTestContext, message: string): void {
  ctx.trackUnsubscribe(
    MakaioBus.on(MessageStorageSubjects.append, () => {
      throw new Error(message);
    }),
  );
}

/**
 * Record successful initial-message appends.
 * @param ctx - Attach test context owning cleanup
 * @returns Captured append payloads
 */
function recordSuccessfulInitialMessageAppends(ctx: AttachHandlerTestContext): unknown[] {
  const appendedMessages: unknown[] = [];
  ctx.trackUnsubscribe(
    registerSuccessfulMessageAppendHandler({
      onAppend: (payload) => appendedMessages.push(payload),
    }),
  );
  return appendedMessages;
}

/**
 * Record turn completion rollback calls.
 * @param ctx - Attach test context owning cleanup
 * @param sessionId - Session id to place on mocked completed turns
 * @returns Captured turn completion payloads
 */
function recordCompletedTurns(
  ctx: AttachHandlerTestContext,
  sessionId: string,
): Array<{ turnId: string; status: string; expectedStatus?: string; error?: string }> {
  const completedTurns: Array<{ turnId: string; status: string; expectedStatus?: string; error?: string }> = [];
  ctx.trackUnsubscribe(
    MakaioBus.on(TurnStorageSubjects.complete, (context) => {
      completedTurns.push(context.payload);
      context.setResult({
        turn: {
          turnId: context.payload.turnId,
          sessionId,
          turnNumber: 1,
          startedAt: Date.now(),
          completedAt: Date.now(),
          status: context.payload.status,
          error: context.payload.error,
        },
        transitioned: true,
      });
    }),
  );
  return completedTurns;
}

/**
 * Record adapter stop calls.
 * @param ctx - Attach test context owning cleanup
 * @returns Captured stop-agent payloads
 */
function recordStoppedAgents(ctx: AttachHandlerTestContext): Array<{ adapterId: string; agentId: string }> {
  const stoppedAgents: Array<{ adapterId: string; agentId: string }> = [];
  ctx.trackUnsubscribe(
    MakaioBus.on(AdapterSubjects.stopAgent, (context) => {
      stoppedAgents.push(context.payload);
      context.setResult({ success: true });
    }),
  );
  return stoppedAgents;
}

/**
 * Collect emitted attach turn-start events.
 * @param ctx - Attach test context owning cleanup
 * @returns Captured turn-start payloads
 */
function collectAttachTurnStartedEvents(ctx: AttachHandlerTestContext): unknown[] {
  const turnStartedEvents: unknown[] = [];
  ctx.trackUnsubscribe(
    MakaioBus.on(SessionSubjects.turn.started, ({ payload }) => {
      turnStartedEvents.push(payload);
    }),
  );
  return turnStartedEvents;
}

/**
 * Register a failing session-events append for turn.started.
 * @param ctx - Attach test context owning cleanup
 * @param message - Error message to throw
 */
function registerFailingTurnStartedPersistence(ctx: AttachHandlerTestContext, message: string): void {
  ctx.trackUnsubscribe(
    MakaioBus.on(SessionEventStorageSubjects.append, (context) => {
      if (context.payload.event.type === 'turn.started') {
        throw new Error(message);
      }
      context.setResult({ success: true });
    }),
  );
}
