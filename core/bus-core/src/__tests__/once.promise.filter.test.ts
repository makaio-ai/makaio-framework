import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('filter option', () => {
    it('should keep listening until filter matches', async () => {
      const promise = MakaioBus.once(EventSubjects.message, {
        filter: { sessionId: 'target-session' },
      });

      // Emit non-matching events
      await MakaioBus.emit(EventSubjects.message, {
        content: 'wrong1',
        sessionId: 'session-1',
      });
      await MakaioBus.emit(EventSubjects.message, {
        content: 'wrong2',
        sessionId: 'session-2',
      });

      // Promise should still be pending
      const resultBefore = await Promise.race([
        promise.then(() => 'resolved'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(resultBefore).toBe('pending');

      // Emit matching event
      await MakaioBus.emit(EventSubjects.message, {
        content: 'correct',
        sessionId: 'target-session',
      });

      const ctx = await promise;
      expect(ctx.payload.content).toBe('correct');
      expect(ctx.payload.sessionId).toBe('target-session');
    });

    it('should cleanup handler after filter match', async () => {
      const context = MakaioBus.getContext();
      const promise = MakaioBus.once(EventSubjects.message, {
        filter: { sessionId: 'target' },
      });

      const fullSubject = 'oncePromise:events.message';
      expect(context.eventHandlers.has(fullSubject)).toBe(true);

      // Emit non-matching event - handler should still exist
      await MakaioBus.emit(EventSubjects.message, {
        content: 'wrong',
        sessionId: 'other',
      });
      expect(context.eventHandlers.has(fullSubject)).toBe(true);

      // Emit matching event
      await MakaioBus.emit(EventSubjects.message, {
        content: 'right',
        sessionId: 'target',
      });
      await promise;

      // Handler should be removed after match
      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });
  });
});
