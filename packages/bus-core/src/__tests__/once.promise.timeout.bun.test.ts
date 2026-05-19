import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { OnceTimeoutError } from '../methods/once.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('timeout option', () => {
    it('should reject with OnceTimeoutError when timeout expires', async () => {
      const promise = MakaioBus.once(EventSubjects.message, { timeoutMs: 100 });

      await expect(promise).rejects.toThrow(OnceTimeoutError);
      await expect(promise).rejects.toThrow(
        'once() timed out after 100ms waiting for subject: oncePromise:events.message',
      );
    });

    it('should resolve if event arrives before timeout', async () => {
      const promise = MakaioBus.once(EventSubjects.message, { timeoutMs: 1000 });

      // Emit after 50ms (before timeout)
      setTimeout(() => {
        void MakaioBus.emit(EventSubjects.message, {
          content: 'in-time',
          sessionId: 'session-1',
        });
      }, 50);

      const ctx = await promise;
      expect(ctx.payload.content).toBe('in-time');
    });

    it('should clear timeout when promise resolves (no leak)', async () => {
      const clearTimeoutSpy = spyOn(global, 'clearTimeout');

      const promise = MakaioBus.once(EventSubjects.message, { timeoutMs: 5000 });

      await MakaioBus.emit(EventSubjects.message, {
        content: 'test',
        sessionId: 'session-1',
      });

      await promise;

      // clearTimeout should be called during cleanup
      expect(clearTimeoutSpy).toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });

    it('should cleanup handler when timeout occurs', async () => {
      const context = MakaioBus.getContext();
      const promise = MakaioBus.once(EventSubjects.message, { timeoutMs: 100 });

      // Handler should be registered initially
      const fullSubject = 'oncePromise:events.message';
      expect(context.eventHandlers.has(fullSubject)).toBe(true);

      // Wait for timeout
      await expect(promise).rejects.toThrow(OnceTimeoutError);

      // Handler should be removed after timeout
      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });
  });
});
