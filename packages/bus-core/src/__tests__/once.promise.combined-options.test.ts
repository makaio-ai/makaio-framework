import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { OnceAbortError, OnceTimeoutError } from '../methods/once.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('combined options', () => {
    it('should work with timeout + filter', async () => {
      const promise = MakaioBus.once(EventSubjects.message, {
        timeoutMs: 500,
        filter: { sessionId: 'target' },
      });

      // Emit non-matching events
      await MakaioBus.emit(EventSubjects.message, {
        content: 'wrong',
        sessionId: 'other',
      });

      // Emit matching event before timeout
      setTimeout(() => {
        void MakaioBus.emit(EventSubjects.message, {
          content: 'correct',
          sessionId: 'target',
        });
      }, 100);

      const ctx = await promise;
      expect(ctx.payload.content).toBe('correct');
    });

    it('should timeout even with filter if no match found', async () => {
      const promise = MakaioBus.once(EventSubjects.message, {
        timeoutMs: 200,
        filter: { sessionId: 'never-matches' },
      });

      // Emit non-matching events
      await MakaioBus.emit(EventSubjects.message, {
        content: 'test',
        sessionId: 'other',
      });

      await expect(promise).rejects.toThrow(OnceTimeoutError);
    });

    it('should work with timeout + signal', async () => {
      const controller = new AbortController();
      const promise = MakaioBus.once(EventSubjects.message, {
        timeoutMs: 1000,
        signal: controller.signal,
      });

      // Abort before timeout
      setTimeout(() => controller.abort(), 100);

      await expect(promise).rejects.toThrow(OnceAbortError);
    });

    it('should work with filter + signal', async () => {
      const controller = new AbortController();
      const promise = MakaioBus.once(EventSubjects.message, {
        filter: { sessionId: 'target' },
        signal: controller.signal,
      });

      // Emit non-matching events
      await MakaioBus.emit(EventSubjects.message, {
        content: 'wrong',
        sessionId: 'other',
      });

      // Abort before matching event
      controller.abort();

      await expect(promise).rejects.toThrow(OnceAbortError);
    });

    it('should work with all options combined', async () => {
      const controller = new AbortController();
      const promise = MakaioBus.once(EventSubjects.message, {
        timeoutMs: 1000,
        filter: { sessionId: 'target' },
        signal: controller.signal,
      });

      // Emit non-matching events
      await MakaioBus.emit(EventSubjects.message, {
        content: 'wrong',
        sessionId: 'other',
      });

      // Emit matching event
      setTimeout(() => {
        void MakaioBus.emit(EventSubjects.message, {
          content: 'correct',
          sessionId: 'target',
        });
      }, 100);

      const ctx = await promise;
      expect(ctx.payload.content).toBe('correct');
    });
  });
});
