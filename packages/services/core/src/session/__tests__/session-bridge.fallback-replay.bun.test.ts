import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
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
    const appendSpy = mock();
    const routingSpy = mock();

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
      messageId: 'user-msg-1',
      content: 'fallback response',
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'fallback-agent',
      adapterId: 'adapter-1',
      adapterName: 'gemini',
      adapterSessionId: 'native-1',
      sessionId: 'session-1',
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
});
