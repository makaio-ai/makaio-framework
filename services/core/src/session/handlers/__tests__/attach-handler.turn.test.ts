import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';
import type { MessageInput } from '@makaio/contracts';
import { ATTACH_TEST_IDS, createAttachHandlerContext, type AttachHandlerTestContext } from './shared.js';
import { waitForAsync } from '../../__tests__/shared.js';

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
