import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { OnceAbortError } from '../methods/once.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('AbortSignal option', () => {
    it('should reject if signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const promise = MakaioBus.once(EventSubjects.message, {
        signal: controller.signal,
      });

      await expect(promise).rejects.toThrow(OnceAbortError);
    });

    it('should reject when signal is aborted during wait', async () => {
      const controller = new AbortController();
      const promise = MakaioBus.once(EventSubjects.message, {
        signal: controller.signal,
      });

      // Abort after 50ms
      setTimeout(() => controller.abort(), 50);

      await expect(promise).rejects.toThrow(OnceAbortError);
    });

    it('should cleanup handler when aborted', async () => {
      const context = MakaioBus.getContext();
      const controller = new AbortController();
      const promise = MakaioBus.once(EventSubjects.message, {
        signal: controller.signal,
      });

      const fullSubject = 'oncePromise:events.message';
      expect(context.eventHandlers.has(fullSubject)).toBe(true);

      controller.abort();

      await expect(promise).rejects.toThrow(OnceAbortError);

      // Handler should be removed after abort
      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });

    it('should resolve normally if signal not aborted', async () => {
      const controller = new AbortController();
      const promise = MakaioBus.once(EventSubjects.message, {
        signal: controller.signal,
      });

      await MakaioBus.emit(EventSubjects.message, {
        content: 'test',
        sessionId: 'session-1',
      });

      const ctx = await promise;
      expect(ctx.payload.content).toBe('test');

      // Should be safe to abort after resolution
      controller.abort();
    });

    it('should remove the abort listener during cleanup', async () => {
      const controller = new AbortController();
      const removeEventListenerSpy = spyOn(controller.signal, 'removeEventListener');
      const promise = MakaioBus.once(EventSubjects.message, {
        signal: controller.signal,
      });

      await MakaioBus.emit(EventSubjects.message, {
        content: 'cleanup',
        sessionId: 'session-1',
      });

      await promise;

      expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    });
  });
});
