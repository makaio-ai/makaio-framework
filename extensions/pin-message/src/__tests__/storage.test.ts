import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { PinStorageSubjects, registerPinStorage } from '../storage.js';

interface PinHandlerContext {
  readonly payload: {
    readonly sessionId?: string;
    readonly messageId?: string;
  };
  readonly setResult: (result: unknown) => void;
}

type PinHandler = (context: PinHandlerContext) => void | Promise<void>;

describe('registerPinStorage', () => {
  afterEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('runs every cleanup and clears pins when one cleanup throws', async () => {
    const cleanupError = new Error('cleanup failed');
    const cleanupCalls: string[] = [];
    const handlers: PinHandler[] = [];
    const bus = {
      on(_subject: unknown, handler: PinHandler) {
        handlers.push(handler);
        const cleanupName = ['check', 'add', 'remove', 'list', 'clear'][handlers.length - 1] ?? 'unknown';
        return () => {
          cleanupCalls.push(cleanupName);
          if (cleanupName === 'check') {
            throw cleanupError;
          }
        };
      },
    } as Pick<IMakaioBus, 'on'>;

    const cleanup = registerPinStorage(bus as IMakaioBus);
    const addHandler = handlers[1];
    expect(addHandler).toBeDefined();
    if (!addHandler) {
      throw new Error('Expected add handler to be registered');
    }

    await addHandler({
      payload: { sessionId: 'session-1', messageId: 'message-1' },
      setResult: vi.fn(),
    });

    expect(cleanup).toThrow(cleanupError);
    expect(cleanupCalls).toEqual(['check', 'add', 'remove', 'list', 'clear']);

    const realCleanup = registerPinStorage(MakaioBus);
    try {
      await expect(MakaioBus.request(PinStorageSubjects.list, { sessionId: 'session-1' })).resolves.toEqual({
        pinnedMessageIds: [],
      });
    } finally {
      realCleanup();
    }
  });

  it('preserves an intentionally thrown undefined cleanup error', () => {
    const noThrow = Symbol('no throw');
    const cleanupCalls: string[] = [];
    const bus = {
      on() {
        return () => {
          cleanupCalls.push('cleanup');
          throw undefined;
        };
      },
    } as Pick<IMakaioBus, 'on'>;

    const cleanup = registerPinStorage(bus as IMakaioBus);
    let caught: unknown = noThrow;
    try {
      cleanup();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeUndefined();
    expect(cleanupCalls).toHaveLength(5);
  });
});
