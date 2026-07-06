import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, SessionSubjects } from '@makaio/contracts';
import type { MessageInput } from '@makaio/contracts';
import { ATTACH_TEST_IDS, createAttachHandlerContext, type AttachHandlerTestContext } from './shared.js';
import { waitForAsync } from '../../__tests__/shared.js';
import { MessageStorageSubjects } from '../../messages/namespace.js';
import { SessionEventStorageSubjects } from '../../session-events/index.js';
import { TurnStorageSubjects } from '../../turns/index.js';

describe('registerAttachHandler - turn tracking', () => {
  const { sessionId, adapterName, agentId, messageId } = ATTACH_TEST_IDS;

  let ctx: AttachHandlerTestContext;

  beforeEach(() => {
    ctx = createAttachHandlerContext();
  });

  afterEach(() => {
    ctx.destroy();
  });

  describe('should setup turn tracking when initialMessage provided', () => {
    it('creates Turn and adds to activeTurns map', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      expect(ctx.activeTurns.has(sessionId)).toBe(true);
      const turn = ctx.activeTurns.get(sessionId);
      expect(turn).toBeDefined();
      expect(turn?.sessionId).toBe(sessionId);
      expect([...turn!.agentIds]).toContain(agentId);
      expect(result.turnId).toBe(turn?.turnId);
      expect(result.messageId).toBe(messageId);
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

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      await waitForAsync();

      expect(turnStartedEvents).toHaveLength(1);
      expect(turnStartedEvents[0].sessionId).toBe(sessionId);
      expect(turnStartedEvents[0].messageId).toBe(messageId);
      expect(turnStartedEvents[0].agentIds).toContain(agentId);
    });

    it('persists the initial user message before emitting turn events', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);

      const lifecycleOrder: string[] = [];
      const appendedMessages: unknown[] = [];
      ctx.trackUnsubscribe(
        MakaioBus.on(MessageStorageSubjects.append, (context) => {
          lifecycleOrder.push('append');
          appendedMessages.push(context.payload.message);
          context.setResult({
            message: {
              ...context.payload.message,
              messageId: context.payload.message.messageId ?? messageId,
            },
          });
        }),
      );
      ctx.trackUnsubscribe(
        MakaioBus.on(SessionSubjects.turn.started, () => {
          lifecycleOrder.push('turn.started');
        }),
      );
      ctx.trackUnsubscribe(ctx.registerHandler());

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      await waitForAsync();

      expect(lifecycleOrder).toEqual(['append', 'turn.started']);
      expect(appendedMessages[0]).toMatchObject({
        messageId,
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

      expect(ctx.activeTurns.has(sessionId)).toBe(false);
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

    it('clears the active turn and rolls back the agent when turn-start persistence fails', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);

      const appendedMessages = recordSuccessfulInitialMessageAppends(ctx, messageId);
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
      expect(ctx.activeTurns.has(sessionId)).toBe(false);
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

      await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
        initialMessage: 'Hello, agent!',
      });

      await waitForAsync();

      expect(acknowledgedEvents).toHaveLength(1);
      expect(acknowledgedEvents[0].sessionId).toBe(sessionId);
      expect(acknowledgedEvents[0].messageId).toBe(messageId);
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
    it('does not add turn to activeTurns map', async () => {
      ctx.trackUnsubscribe(ctx.registerSessionGetHandler(ctx.createMockSession()));
      const { unsubscribe } = ctx.registerStartAgentHandler();
      ctx.trackUnsubscribe(unsubscribe);
      ctx.trackUnsubscribe(ctx.registerHandler());

      const result = await MakaioBus.request(SessionSubjects.agent.attach, {
        sessionId,
        agent: { kind: 'adapter', adapterName },
      });

      expect(ctx.activeTurns.has(sessionId)).toBe(false);
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
 * @param fallbackMessageId - Message id used when the payload does not carry one
 * @returns Captured append payloads
 */
function recordSuccessfulInitialMessageAppends(ctx: AttachHandlerTestContext, fallbackMessageId: string): unknown[] {
  const appendedMessages: unknown[] = [];
  ctx.trackUnsubscribe(
    MakaioBus.on(MessageStorageSubjects.append, (context) => {
      appendedMessages.push(context.payload);
      context.setResult({
        message: {
          ...context.payload.message,
          messageId: context.payload.message.messageId ?? fallbackMessageId,
        },
      });
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
