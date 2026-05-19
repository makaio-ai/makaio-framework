import { describe, it, expect, beforeEach } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('edge cases', () => {
    it('should work without any options', async () => {
      const promise = MakaioBus.once(EventSubjects.message, undefined);

      await MakaioBus.emit(EventSubjects.message, {
        content: 'test',
        sessionId: 'session-1',
      });

      const ctx = await promise;
      expect(ctx.payload.content).toBe('test');
    });

    it('should work with empty options object', async () => {
      const promise = MakaioBus.once(EventSubjects.message, {});

      await MakaioBus.emit(EventSubjects.message, {
        content: 'test',
        sessionId: 'session-1',
      });

      const ctx = await promise;
      expect(ctx.payload.content).toBe('test');
    });

    it('should handle rapid sequential emits correctly', async () => {
      const promise = MakaioBus.once(EventSubjects.message);

      // Emit multiple events rapidly
      void MakaioBus.emit(EventSubjects.message, {
        content: 'first',
        sessionId: 'session-1',
      });
      void MakaioBus.emit(EventSubjects.message, {
        content: 'second',
        sessionId: 'session-2',
      });
      void MakaioBus.emit(EventSubjects.message, {
        content: 'third',
        sessionId: 'session-3',
      });

      const ctx = await promise;
      // Should resolve with first event
      expect(ctx.payload.content).toBe('first');
    });
  });
});
