import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import type { SessionMessage } from '@makaio/contracts';
import { MessageStorageSubjects } from '../namespace.js';
import { SessionEventStorageSubjects } from '../../session-events/namespace.js';
import { emitMessageSessionEvent } from '../shared.js';

function createMessage(): SessionMessage {
  return {
    messageId: 'msg-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    role: 'assistant',
    contentText: 'hello',
    blocks: [{ type: 'text', content: 'hello' }],
    timestamp: 123,
  };
}

describe('emitMessageSessionEvent', () => {
  const emit = vi.fn();
  const request = vi.fn();
  const bus: Pick<IMakaioBus, 'emit' | 'request'> = { emit, request };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits storage:message.stored and appends session event', async () => {
    request.mockResolvedValue({ success: true });

    const message = createMessage();
    await emitMessageSessionEvent(bus, message);

    expect(emit).toHaveBeenCalledWith(
      MessageStorageSubjects.stored,
      expect.objectContaining({ message: expect.objectContaining(message) }),
    );
    const emittedMessage = emit.mock.calls[0]?.[1]?.message as SessionMessage;
    expect(emittedMessage).not.toBe(message);
    expect(emittedMessage.blocks).not.toBe(message.blocks);
    expect(request).toHaveBeenCalledWith(
      SessionEventStorageSubjects.append,
      expect.objectContaining({
        event: expect.objectContaining({
          sessionId: message.sessionId,
          timestamp: message.timestamp,
          type: 'message',
          payload: expect.objectContaining({
            messageId: message.messageId,
            turnId: message.turnId,
            role: message.role,
          }),
        }),
      }),
    );
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
  });

  it('swallows session event append failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      request.mockRejectedValue(new Error('append failed'));

      await expect(emitMessageSessionEvent(bus, createMessage())).resolves.toBeUndefined();

      expect(emit).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        '[MessageStorage] Failed to emit session event for message:',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
