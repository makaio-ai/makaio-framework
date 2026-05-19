import { describe, it, expect, beforeEach } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { oncePromiseTestSetup } from './once.promise.setup.js';

const setup = oncePromiseTestSetup();
const { EventSubjects } = setup;

describe('once - Promise overload', () => {
  beforeEach(() => {
    setup.beforeEach();
  });

  describe('memory cleanup verification', () => {
    it('should remove handler after successful resolution', async () => {
      const context = MakaioBus.getContext();
      const promise = MakaioBus.once(EventSubjects.message);

      const fullSubject = 'oncePromise:events.message';
      expect(context.eventHandlers.has(fullSubject)).toBe(true);

      await MakaioBus.emit(EventSubjects.message, {
        content: 'test',
        sessionId: 'session-1',
      });

      await promise;

      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });

    it('should not leak handlers with multiple promise instances', async () => {
      const context = MakaioBus.getContext();

      // Create multiple promises
      const promise1 = MakaioBus.once(EventSubjects.message, {
        filter: { sessionId: 'session-1' },
      });
      const promise2 = MakaioBus.once(EventSubjects.message, {
        filter: { sessionId: 'session-2' },
      });
      const promise3 = MakaioBus.once(EventSubjects.message, {
        filter: { sessionId: 'session-3' },
      });

      const fullSubject = 'oncePromise:events.message';
      expect(context.eventHandlers.get(fullSubject)?.length).toBe(3);

      // Resolve first promise
      await MakaioBus.emit(EventSubjects.message, {
        content: 'msg1',
        sessionId: 'session-1',
      });
      await promise1;
      expect(context.eventHandlers.get(fullSubject)?.length).toBe(2);

      // Resolve second promise
      await MakaioBus.emit(EventSubjects.message, {
        content: 'msg2',
        sessionId: 'session-2',
      });
      await promise2;
      expect(context.eventHandlers.get(fullSubject)?.length).toBe(1);

      // Resolve third promise
      await MakaioBus.emit(EventSubjects.message, {
        content: 'msg3',
        sessionId: 'session-3',
      });
      await promise3;
      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });
  });
});
