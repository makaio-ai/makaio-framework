/**
 * Tests for the `once` method that auto-unsubscribes after first invocation.
 *
 * These tests verify that:
 * 1. Handler fires exactly once then auto-unsubscribes
 * 2. Manual unsubscribe works before event fires
 * 3. Multiple once handlers all fire independently
 * 4. Works with exact subjects, subject wildcards, and namespace wildcards
 * 5. Works with both event and request subjects
 * 6. No memory leaks (handlers removed from Map)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';

// Register test namespaces for once tests
const { subjects: EventSubjects } = MakaioBus.registerNamespace('onceTest:events', {
  log: z.object({ message: z.string() }),
  error: z.object({ error: z.string() }),
  warning: z.object({ warning: z.string() }),
});

const { subjects: RequestSubjects } = MakaioBus.registerNamespace('onceTest:requests', {
  getData: {
    request: z.object({ id: z.string() }),
    response: z.object({ data: z.string() }),
  },
  processTask: {
    request: z.object({ taskId: z.string() }),
    response: z.object({ status: z.string() }),
  },
});

describe('once', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('basic behavior - events', () => {
    it('should fire handler once then auto-unsubscribe', async () => {
      const received: string[] = [];

      MakaioBus.once(EventSubjects.log, (context) => {
        received.push(context.payload.message);
      });

      await MakaioBus.emit(EventSubjects.log, { message: 'first' });
      expect(received).toEqual(['first']);

      await MakaioBus.emit(EventSubjects.log, { message: 'second' });
      expect(received).toEqual(['first']);
    });

    it('should support multiple once handlers on same subject', async () => {
      const received1: string[] = [];
      const received2: string[] = [];

      MakaioBus.once(EventSubjects.log, (context) => {
        received1.push(context.payload.message);
      });

      MakaioBus.once(EventSubjects.log, (context) => {
        received2.push(context.payload.message);
      });

      await MakaioBus.emit(EventSubjects.log, { message: 'test' });
      expect(received1).toEqual(['test']);
      expect(received2).toEqual(['test']);

      await MakaioBus.emit(EventSubjects.log, { message: 'test2' });
      expect(received1).toEqual(['test']);
      expect(received2).toEqual(['test']);
    });
  });

  describe('manual unsubscribe', () => {
    it('should allow manual unsubscribe before and after firing', async () => {
      const received: string[] = [];

      const unsubscribe1 = MakaioBus.once(EventSubjects.log, (context) => {
        received.push(`handler1:${context.payload.message}`);
      });

      unsubscribe1();
      await MakaioBus.emit(EventSubjects.log, { message: 'test' });
      expect(received).toEqual([]);

      const unsubscribe2 = MakaioBus.once(EventSubjects.log, (context) => {
        received.push(`handler2:${context.payload.message}`);
      });

      await MakaioBus.emit(EventSubjects.log, { message: 'test2' });
      expect(received).toEqual(['handler2:test2']);

      unsubscribe2();
      unsubscribe2();
    });
  });

  describe('exact subject matching', () => {
    it('should only fire for exact subject match', async () => {
      const logReceived: string[] = [];
      const errorReceived: string[] = [];
      const warningReceived: string[] = [];

      MakaioBus.once(EventSubjects.log, (context) => {
        logReceived.push(context.payload.message);
      });

      MakaioBus.once(EventSubjects.error, (context) => {
        errorReceived.push(context.payload.error);
      });

      MakaioBus.once(EventSubjects.warning, (context) => {
        warningReceived.push(context.payload.warning);
      });

      // Emit different events
      await MakaioBus.emit(EventSubjects.log, { message: 'log message' });
      await MakaioBus.emit(EventSubjects.error, { error: 'error message' });
      await MakaioBus.emit(EventSubjects.warning, { warning: 'warning message' });

      // Each handler should fire once for its subject
      expect(logReceived).toEqual(['log message']);
      expect(errorReceived).toEqual(['error message']);
      expect(warningReceived).toEqual(['warning message']);

      // Emit again - no handlers should fire
      await MakaioBus.emit(EventSubjects.log, { message: 'log 2' });
      await MakaioBus.emit(EventSubjects.error, { error: 'error 2' });
      await MakaioBus.emit(EventSubjects.warning, { warning: 'warning 2' });

      expect(logReceived).toEqual(['log message']);
      expect(errorReceived).toEqual(['error message']);
      expect(warningReceived).toEqual(['warning message']);
    });
  });

  describe('wildcard patterns', () => {
    it('should work with namespace wildcard (.$all)', async () => {
      const received: unknown[] = [];

      MakaioBus.once(EventSubjects.$all, (context) => {
        received.push(context.payload);
      });

      await MakaioBus.emit(EventSubjects.log, { message: 'first' });
      expect(received).toEqual([{ message: 'first' }]);

      await MakaioBus.emit(EventSubjects.error, { error: 'second' });
      expect(received).toEqual([{ message: 'first' }]);
    });
  });

  describe('request subjects', () => {
    it('should work with request handlers', async () => {
      const requestCount: number[] = [];

      MakaioBus.once(RequestSubjects.getData, (context) => {
        requestCount.push(1);
        context.setResult({ data: `data-${context.payload.id}` });
      });

      // First request - handler should fire
      const result1 = await MakaioBus.request(RequestSubjects.getData, { id: '123' });
      expect(result1.data).toBe('data-123');
      expect(requestCount).toEqual([1]);

      // Second request - handler should NOT fire (NoHandlerError expected)
      await expect(MakaioBus.request(RequestSubjects.getData, { id: '456' })).rejects.toThrow(
        'No handler registered for request subject "onceTest:requests.getData"',
      );
      expect(requestCount).toEqual([1]);
    });

    it('should work with request wildcard handlers', async () => {
      const received: unknown[] = [];

      MakaioBus.once(RequestSubjects.$all, (context) => {
        if (context.isRequest) {
          received.push(context.payload);
          context.setResult({ data: 'handled' });
        }
      });

      // First request - handler should fire
      const result1 = await MakaioBus.request(RequestSubjects.getData, { id: '123' });
      expect(result1).toEqual({ data: 'handled' });
      expect(received).toEqual([{ id: '123' }]);

      // Second request (different subject) - handler should NOT fire
      await expect(MakaioBus.request(RequestSubjects.processTask, { taskId: 'task-1' })).rejects.toThrow(
        'No handler registered for request subject "onceTest:requests.processTask"',
      );
      expect(received).toEqual([{ id: '123' }]);
    });
  });

  describe('memory cleanup', () => {
    it('should remove handler from map after firing', async () => {
      const context = MakaioBus.getContext();

      MakaioBus.once(EventSubjects.log, (ctx) => {
        void ctx; // noop
      });

      // Handler should be registered
      const fullSubject = 'onceTest:events.log';
      expect(context.eventHandlers.has(fullSubject)).toBe(true);
      expect(context.eventHandlers.get(fullSubject)?.length).toBe(1);

      // Emit event
      await MakaioBus.emit(EventSubjects.log, { message: 'test' });

      // Handler should be removed and entry should be deleted
      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });

    it('should remove handler from map when manually unsubscribed', async () => {
      const context = MakaioBus.getContext();

      const unsubscribe = MakaioBus.once(EventSubjects.log, (ctx) => {
        void ctx; // noop
      });

      // Handler should be registered
      const fullSubject = 'onceTest:events.log';
      expect(context.eventHandlers.has(fullSubject)).toBe(true);
      expect(context.eventHandlers.get(fullSubject)?.length).toBe(1);

      // Manually unsubscribe
      unsubscribe();

      // Handler should be removed and entry should be deleted
      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });

    it('should clean up only fired handler when multiple once handlers exist', async () => {
      const context = MakaioBus.getContext();
      const received1: string[] = [];
      const received2: string[] = [];

      MakaioBus.once(EventSubjects.log, (ctx) => {
        received1.push(ctx.payload.message);
      });

      MakaioBus.once(EventSubjects.log, (ctx) => {
        received2.push(ctx.payload.message);
      });

      const fullSubject = 'onceTest:events.log';
      expect(context.eventHandlers.get(fullSubject)?.length).toBe(2);

      // Emit - both handlers fire and both should be removed
      await MakaioBus.emit(EventSubjects.log, { message: 'test' });

      expect(received1).toEqual(['test']);
      expect(received2).toEqual(['test']);
      expect(context.eventHandlers.has(fullSubject)).toBe(false);
    });
  });

  describe('interaction with regular on() handlers', () => {
    it('should work alongside regular on() handlers', async () => {
      const onceReceived: string[] = [];
      const onReceived: string[] = [];

      MakaioBus.once(EventSubjects.log, (context) => {
        onceReceived.push(context.payload.message);
      });

      MakaioBus.on(EventSubjects.log, (context) => {
        onReceived.push(context.payload.message);
      });

      // First emit - both handlers fire
      await MakaioBus.emit(EventSubjects.log, { message: 'first' });
      expect(onceReceived).toEqual(['first']);
      expect(onReceived).toEqual(['first']);

      // Second emit - only on() handler fires
      await MakaioBus.emit(EventSubjects.log, { message: 'second' });
      expect(onceReceived).toEqual(['first']);
      expect(onReceived).toEqual(['first', 'second']);

      // Third emit - only on() handler fires
      await MakaioBus.emit(EventSubjects.log, { message: 'third' });
      expect(onceReceived).toEqual(['first']);
      expect(onReceived).toEqual(['first', 'second', 'third']);
    });
  });

  describe('scoped bus integration', () => {
    it('should work with scoped bus and unsubscribe correctly', async () => {
      const namespace = MakaioBus.registerNamespace('onceTest:scoped', {
        event: z.object({ value: z.string() }),
      });

      const scopedBus = MakaioBus.scoped(namespace);
      const received: string[] = [];

      scopedBus.once(namespace.subjects.event, (context) => {
        received.push(context.payload.value);
      });

      await scopedBus.emit(namespace.subjects.event, { value: 'first' });
      expect(received).toEqual(['first']);

      await scopedBus.emit(namespace.subjects.event, { value: 'second' });
      expect(received).toEqual(['first']);
    });
  });

  describe('edge cases', () => {
    it('should unsubscribe even if handler has side effects', async () => {
      const received: string[] = [];
      const context = MakaioBus.getContext();

      MakaioBus.once(EventSubjects.log, (ctx) => {
        received.push(ctx.payload.message);
        // Handler executes but we verify it's removed from the map
      });

      const fullSubject = 'onceTest:events.log';
      expect(context.eventHandlers.has(fullSubject)).toBe(true);

      // Emit - handler fires
      await MakaioBus.emit(EventSubjects.log, { message: 'test' });
      expect(received).toEqual(['test']);
      expect(context.eventHandlers.has(fullSubject)).toBe(false);

      // Emit again - handler should not fire
      await MakaioBus.emit(EventSubjects.log, { message: 'test2' });
      expect(received).toEqual(['test']);
    });

    it('should handle handler that recursively emits same event', async () => {
      const received: string[] = [];
      let recursionCount = 0;

      MakaioBus.once(EventSubjects.log, async (context) => {
        received.push(context.payload.message);
        recursionCount++;

        if (recursionCount < 3) {
          // Recursively emit - handler should NOT fire again
          await MakaioBus.emit(EventSubjects.log, { message: `recursive-${recursionCount}` });
        }
      });

      await MakaioBus.emit(EventSubjects.log, { message: 'initial' });

      // Handler should fire only once (for 'initial')
      expect(received).toEqual(['initial']);
      expect(recursionCount).toBe(1);
    });

    it('should unsubscribe filtered once handler before invoking throwing handler', async () => {
      const namespace = MakaioBus.registerNamespace('onceTest:filtered', {
        event: z.object({ kind: z.string() }),
      });
      const filteredBus = MakaioBus.scoped(namespace).withFilter({ kind: 'match' });
      const received: string[] = [];

      filteredBus.once(namespace.subjects.event, (ctx) => {
        received.push(ctx.payload.kind);
        throw new Error('boom');
      });

      await expect(filteredBus.emit(namespace.subjects.event, { kind: 'match' })).rejects.toThrow('boom');

      // Handler should be removed even after throw; follow-up emits must not re-fire it.
      await filteredBus.emit(namespace.subjects.event, { kind: 'match' });
      await filteredBus.emit(namespace.subjects.event, { kind: 'other' });

      expect(received).toEqual(['match']);
      expect(MakaioBus.getContext().eventHandlers.has('onceTest:filtered.event')).toBe(false);
    });
  });
});
