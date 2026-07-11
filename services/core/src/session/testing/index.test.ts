import { MakaioBus } from '@makaio/bus-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { registerMockStorageHandlers } from './index.js';

describe('registerMockStorageHandlers', () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    unsubscribe = registerMockStorageHandlers();
  });

  afterEach(() => {
    unsubscribe?.();
    MakaioBus.__resetHandlers?.();
  });

  it('round-trips stored messages and honors event suppression', async () => {
    const storedMessages: string[] = [];
    const unsubscribeStored = MakaioBus.on(MessageStorageSubjects.stored, (ctx) => {
      storedMessages.push(ctx.payload.message.messageId);
    });

    const { message } = await MakaioBus.request(MessageStorageSubjects.append, {
      message: {
        messageId: 'message-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        role: 'user',
        contentText: 'hello',
        blocks: [{ type: 'text', content: 'hello' }],
        timestamp: 1,
        origin: 'voice',
      },
      emitEvent: false,
    });
    const byTurn = await MakaioBus.request(MessageStorageSubjects.getByTurn, { turnId: 'turn-1' });

    expect(message.origin).toBe('voice');
    expect(byTurn.messages).toEqual([message]);
    expect(storedMessages).toEqual([]);

    await MakaioBus.request(MessageStorageSubjects.append, {
      message: {
        messageId: 'message-2',
        turnId: 'turn-1',
        sessionId: 'session-1',
        role: 'assistant',
        contentText: 'response',
        blocks: [{ type: 'text', content: 'response' }],
        timestamp: 2,
      },
    });
    await vi.waitFor(() => expect(storedMessages).toEqual(['message-2']));

    unsubscribeStored();
  });
});
