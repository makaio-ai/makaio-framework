import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('basic promise resolution', () => {
    it('should resolve with event context when event is emitted', async () => {
      const promise = MakaioBus.once(EventSubjects.message);

      await MakaioBus.emit(EventSubjects.message, {
        content: 'hello',
        sessionId: 'session-1',
      });

      const ctx = await promise;
      expect(ctx.payload).toEqual({
        content: 'hello',
        sessionId: 'session-1',
      });
      expect(ctx.subject).toBe('oncePromise:events.message');
    });

    it('should resolve before emit completes (event fired first)', async () => {
      const emitPromise = MakaioBus.emit(EventSubjects.message, {
        content: 'test',
        sessionId: 'session-1',
      });

      const promise = MakaioBus.once(EventSubjects.message);

      await emitPromise;

      // Promise should not resolve because once was registered after emit
      const result = await Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), 100))]);
      expect(result).toBe('timeout');
    });

    it('should have correct payload typing', async () => {
      const ctx = MakaioBus.once(EventSubjects.message);

      await MakaioBus.emit(EventSubjects.message, {
        content: 'typed',
        sessionId: 'session-1',
      });

      const resolved = await ctx;

      // TypeScript should infer correct type
      const content: string = resolved.payload.content;
      const sessionId: string = resolved.payload.sessionId;

      expect(content).toBe('typed');
      expect(sessionId).toBe('session-1');
    });
  });
});
