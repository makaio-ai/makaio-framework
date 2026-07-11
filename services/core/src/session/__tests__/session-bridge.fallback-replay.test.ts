import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { SessionBridge } from '../session-bridge.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { MessageRoutingSubjects } from '../message-routing/namespace.js';

describe('SessionBridge fallback replay accumulation', () => {
  const cleanups: Array<() => void> = [];
  let bridge: SessionBridge;

  beforeEach(() => {
    bridge = new SessionBridge(MakaioBus);
  });

  afterEach(() => {
    bridge.destroy();
    cleanups.forEach((cleanup) => cleanup());
    cleanups.length = 0;
  });

  it('stores assistant output after acknowledged-only fallback replay flow', async () => {
    const appendSpy = vi.fn();
    const routingSpy = vi.fn();

    cleanups.push(
      MakaioBus.on(MessageStorageSubjects.append, (ctx) => {
        appendSpy(ctx.payload);
        const message = ctx.payload.message;
        ctx.setResult({
          message: {
            messageId: message.messageId ?? 'assistant-msg-1',
            turnId: message.turnId,
            sessionId: message.sessionId,
            role: message.role,
            contentText: message.contentText,
            blocks: message.blocks,
            agentId: message.agentId,
            adapterSessionId: message.adapterSessionId,
            timestamp: message.timestamp,
          },
        });
      }),
    );
    cleanups.push(
      MakaioBus.on(MessageStorageSubjects.getByTurn, (ctx) => {
        ctx.setResult({
          messages: [
            {
              messageId: 'user-msg-1',
              turnId: ctx.payload.turnId,
              sessionId: 'session-1',
              role: 'user',
              contentText: 'hello',
              blocks: [{ type: 'text', content: 'hello' }],
              timestamp: Date.now(),
            },
          ],
        });
      }),
    );
    cleanups.push(
      MakaioBus.on(MessageRoutingSubjects.record, (ctx) => {
        routingSpy(ctx.payload);
        ctx.setResult({ success: true });
      }),
    );

    await MakaioBus.emit(SessionSubjects.user_message.acknowledged, {
      sessionId: 'session-1',
      turnId: 'turn-1',
      turnNumber: 1,
      messageId: 'user-msg-1',
      agentId: 'fallback-agent',
    });

    await MakaioBus.emit(AgentSubjects.message, {
      agentId: 'fallback-agent',
      adapterId: 'adapter-1',
      adapterName: 'gemini',
      adapterSessionId: 'native-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'user-msg-1',
      content: 'fallback response',
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'fallback-agent',
      adapterId: 'adapter-1',
      adapterName: 'gemini',
      adapterSessionId: 'native-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      messageId: 'user-msg-1',
    });

    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          turnId: 'turn-1',
          sessionId: 'session-1',
          role: 'assistant',
          contentText: 'fallback response',
        }),
      }),
    );
    expect(routingSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'user-msg-1',
        agentId: 'fallback-agent',
        status: 'completed',
      }),
    );
  });

  it('stores validated structured-output completion instead of provisional retry blocks', async () => {
    const appendSpy = vi.fn();

    cleanups.push(
      MakaioBus.on(MessageStorageSubjects.append, (ctx) => {
        appendSpy(ctx.payload);
        const message = ctx.payload.message;
        ctx.setResult({
          message: {
            messageId: message.messageId ?? 'assistant-msg-structured',
            turnId: message.turnId,
            sessionId: message.sessionId,
            role: message.role,
            contentText: message.contentText,
            blocks: message.blocks,
            agentId: message.agentId,
            adapterSessionId: message.adapterSessionId,
            timestamp: message.timestamp,
          },
        });
      }),
    );

    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: 'session-structured',
      turnId: 'turn-structured',
      turnNumber: 1,
      messageId: 'user-msg-structured',
      agentIds: ['structured-agent'],
    });

    await MakaioBus.emit(AgentSubjects.message, {
      agentId: 'structured-agent',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      adapterSessionId: 'native-structured',
      sessionId: 'session-structured',
      turnId: 'turn-structured',
      messageId: 'user-msg-structured',
      content: '{"answer":7}',
    });

    await MakaioBus.emit(AgentSubjects.reasoning, {
      agentId: 'structured-agent',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      adapterSessionId: 'native-structured',
      sessionId: 'session-structured',
      turnId: 'turn-structured',
      messageId: 'user-msg-structured',
      content: 'retrying schema mismatch',
    });

    await MakaioBus.emit(AgentSubjects.message, {
      agentId: 'structured-agent',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      adapterSessionId: 'native-structured',
      sessionId: 'session-structured',
      messageId: 'user-msg-structured',
      content: '{"answer":"fixed"}',
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'structured-agent',
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      adapterSessionId: 'native-structured',
      sessionId: 'session-structured',
      turnId: 'turn-structured',
      messageId: 'user-msg-structured',
      message: '{"answer":"fixed"}',
      outcome: 'completed',
      structuredOutputValidation: { status: 'passed' },
    });

    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          turnId: 'turn-structured',
          sessionId: 'session-structured',
          role: 'assistant',
          contentText: '{"answer":"fixed"}',
          blocks: [{ type: 'text', content: '{"answer":"fixed"}' }],
        }),
      }),
    );
  });

  it('persists and updates routing for each explicitly completed user-message pair', async () => {
    const appendSpy = vi.fn();
    const routingSpy = vi.fn();
    cleanups.push(
      MakaioBus.on(MessageStorageSubjects.append, (ctx) => {
        appendSpy(ctx.payload.message);
        ctx.setResult({
          message: {
            ...ctx.payload.message,
            messageId: ctx.payload.message.messageId ?? crypto.randomUUID(),
            blocks: ctx.payload.message.blocks ?? [],
          },
        });
      }),
      MakaioBus.on(MessageStorageSubjects.getByTurn, (ctx) => {
        ctx.setResult({
          messages: [
            {
              messageId: 'm1',
              turnId: 'turn-pairs',
              sessionId: 'session-pairs',
              role: 'user',
              contentText: 'one',
              blocks: [],
              timestamp: 1,
            },
            {
              messageId: 'm2',
              turnId: 'turn-pairs',
              sessionId: 'session-pairs',
              role: 'user',
              contentText: 'two',
              blocks: [],
              timestamp: 2,
            },
          ],
        });
      }),
      MakaioBus.on(MessageRoutingSubjects.record, (ctx) => {
        routingSpy(ctx.payload);
        ctx.setResult({ success: true });
      }),
    );

    await MakaioBus.emit(SessionSubjects.turn.started, {
      sessionId: 'session-pairs',
      turnId: 'turn-pairs',
      turnNumber: 1,
      messageId: 'm1',
      agentIds: ['agent-1'],
    });
    await MakaioBus.emit(SessionSubjects.user_message.sent, {
      sessionId: 'session-pairs',
      turnId: 'turn-pairs',
      turnNumber: 1,
      messageId: 'm2',
      content: 'two',
      agentIds: ['agent-1'],
    });
    for (const [messageId, content] of [
      ['m1', 'first'],
      ['m2', 'second'],
    ] as const) {
      await MakaioBus.emit(AgentSubjects.message, {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'gemini',
        adapterSessionId: 'native-1',
        sessionId: 'session-pairs',
        turnId: 'turn-pairs',
        messageId,
        content,
      });
    }
    // Deliberately complete the later message first.
    for (const messageId of ['m2', 'm1']) {
      await MakaioBus.emit(AgentSubjects.complete, {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'gemini',
        adapterSessionId: 'native-1',
        sessionId: 'session-pairs',
        turnId: 'turn-pairs',
        messageId,
      });
    }

    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy.mock.calls.map(([message]) => message.contentText)).toEqual(
      expect.arrayContaining(['first', 'second']),
    );
    expect(routingSpy.mock.calls.map(([entry]) => entry.messageId)).toEqual(expect.arrayContaining(['m1', 'm2']));
  });
});
