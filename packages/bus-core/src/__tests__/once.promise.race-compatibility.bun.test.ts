import { describe, it, expect, beforeEach } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('Promise.race compatibility', () => {
    it('should work with Promise.race', async () => {
      const oncePromise = MakaioBus.once(EventSubjects.message);
      const timeoutPromise = new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100));

      // Emit after 50ms
      setTimeout(() => {
        void MakaioBus.emit(EventSubjects.message, {
          content: 'fast',
          sessionId: 'session-1',
        });
      }, 50);

      const result = await Promise.race([oncePromise.then(() => 'event'), timeoutPromise]);

      expect(result).toBe('event');
    });

    it('should work with Promise.all', async () => {
      const promise1 = MakaioBus.once(EventSubjects.message);
      const promise2 = MakaioBus.once(EventSubjects.status);

      await Promise.all([
        MakaioBus.emit(EventSubjects.message, {
          content: 'msg',
          sessionId: 'session-1',
        }),
        MakaioBus.emit(EventSubjects.status, { status: 'ready' }),
      ]);

      const [ctx1, ctx2] = await Promise.all([promise1, promise2]);

      expect(ctx1.payload.content).toBe('msg');
      expect(ctx2.payload.status).toBe('ready');
    });
  });
});
