import { describe, expect, it, vi } from 'vitest';
import { markCompletedWithFinalResult, MessageHandle } from '../message-handle.js';
import type { MessageResult } from '../types.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function createHandle(messageId: string): MessageHandle {
  return new MessageHandle(
    messageId,
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'Return JSON' }],
      message: 'Return JSON',
    },
    'enqueue',
  );
}

describe('MessageHandle', () => {
  it('notifies completion callbacks only after async transforms produce the final result', async () => {
    const transformReady = createDeferred<MessageResult>();
    const handle = createHandle('message-final-callback');
    const onComplete = vi.fn();

    handle.addCompletionTransform(async () => transformReady.promise);
    const notification = markCompletedWithFinalResult(
      handle,
      { outcome: 'completed', result: { message: 'raw provider text' } },
      onComplete,
    );

    await Promise.resolve();
    expect(onComplete).not.toHaveBeenCalled();

    const finalResult: MessageResult = {
      outcome: 'completed',
      result: { message: '{"ok":true}' },
    };
    transformReady.resolve(finalResult);

    await expect(notification).resolves.toBeUndefined();
    expect(onComplete).toHaveBeenCalledWith(handle, finalResult);
    await expect(handle.waitForCompletion()).resolves.toEqual(finalResult);
  });

  it('logs callback failures without changing canonical completion', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handle = createHandle('message-callback-error');
    const finalResult: MessageResult = {
      outcome: 'completed',
      result: { message: '{"ok":true}' },
    };
    handle.addCompletionTransform(() => finalResult);

    try {
      await expect(
        markCompletedWithFinalResult(handle, { outcome: 'completed', result: { message: 'raw' } }, () => {
          throw new Error('completion observer failed');
        }),
      ).resolves.toBeUndefined();
      await expect(handle.waitForCompletion()).resolves.toEqual(finalResult);
      expect(consoleWarn).toHaveBeenCalledWith(
        `[MessageHandle] completion notification failed for messageId: ${handle.messageId}`,
        expect.any(Error),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
