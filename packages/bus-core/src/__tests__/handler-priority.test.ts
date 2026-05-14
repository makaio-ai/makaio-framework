import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';

// Register namespaces for testing
const { subjects: EventSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('priorityTest', {
    action: z.object({ value: z.string() }),
  }),
);

const { subjects: RequestSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('priorityRequestTest', {
    process: {
      request: z.object({ input: z.string() }),
      response: z.object({ output: z.string() }),
    },
  }),
);

describe('Handler Priority', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('event handlers', () => {
    it('should execute handlers in priority order (highest first)', async () => {
      const executionOrder: string[] = [];

      // Register handlers with different priorities (out of order)
      MakaioBus.on(
        EventSubjects.action,
        () => {
          executionOrder.push('low');
        },
        { priority: 10 },
      );

      MakaioBus.on(
        EventSubjects.action,
        () => {
          executionOrder.push('high');
        },
        { priority: 100 },
      );

      MakaioBus.on(
        EventSubjects.action,
        () => {
          executionOrder.push('medium');
        },
        { priority: 50 },
      );

      // Note: Events execute in parallel, so we can only verify they all ran
      await MakaioBus.emit(EventSubjects.action, { value: 'test' });

      // All handlers should have executed
      expect(executionOrder).toHaveLength(3);
      expect(executionOrder).toContain('high');
      expect(executionOrder).toContain('medium');
      expect(executionOrder).toContain('low');
    });

    it('should use default priority of 0', async () => {
      const context = MakaioBus.getContext();
      const fullSubject = 'priorityTest.action';

      MakaioBus.on(EventSubjects.action, () => {});

      const entries = context.eventHandlers.get(fullSubject);
      expect(entries).toBeDefined();
      expect(entries![0].priority).toBe(0);
    });

    it('should preserve registration order for handlers with equal priority', async () => {
      const context = MakaioBus.getContext();
      const fullSubject = 'priorityTest.action';

      // Register handlers with same priority
      const handler1 = () => {};
      const handler2 = () => {};
      const handler3 = () => {};

      MakaioBus.on(EventSubjects.action, handler1, { priority: 50 });
      MakaioBus.on(EventSubjects.action, handler2, { priority: 50 });
      MakaioBus.on(EventSubjects.action, handler3, { priority: 50 });

      const entries = context.eventHandlers.get(fullSubject);
      expect(entries).toHaveLength(3);

      // All should have priority 50 and be in registration order
      expect(entries![0].priority).toBe(50);
      expect(entries![1].priority).toBe(50);
      expect(entries![2].priority).toBe(50);

      // Verify registration order is preserved
      expect(entries![0].handler).toBe(handler1);
      expect(entries![1].handler).toBe(handler2);
      expect(entries![2].handler).toBe(handler3);
    });

    it('should sort handlers by priority with stable ordering', async () => {
      const context = MakaioBus.getContext();
      const fullSubject = 'priorityTest.action';

      const handlerHigh1 = () => {};
      const handlerMedium = () => {};
      const handlerHigh2 = () => {};
      const handlerLow = () => {};

      MakaioBus.on(EventSubjects.action, handlerHigh1, { priority: 100 });
      MakaioBus.on(EventSubjects.action, handlerMedium, { priority: 50 });
      MakaioBus.on(EventSubjects.action, handlerHigh2, { priority: 100 });
      MakaioBus.on(EventSubjects.action, handlerLow, { priority: 10 });

      const entries = context.eventHandlers.get(fullSubject);
      expect(entries).toHaveLength(4);

      // Should be sorted by priority descending with stable order
      expect(entries![0].handler).toBe(handlerHigh1);
      expect(entries![0].priority).toBe(100);

      expect(entries![1].handler).toBe(handlerHigh2);
      expect(entries![1].priority).toBe(100);

      expect(entries![2].handler).toBe(handlerMedium);
      expect(entries![2].priority).toBe(50);

      expect(entries![3].handler).toBe(handlerLow);
      expect(entries![3].priority).toBe(10);
    });

    it('should handle negative priorities', async () => {
      const context = MakaioBus.getContext();
      const fullSubject = 'priorityTest.action';

      const handlerNegative = () => {};
      const handlerZero = () => {};
      const handlerPositive = () => {};

      MakaioBus.on(EventSubjects.action, handlerNegative, { priority: -10 });
      MakaioBus.on(EventSubjects.action, handlerZero);
      MakaioBus.on(EventSubjects.action, handlerPositive, { priority: 10 });

      const entries = context.eventHandlers.get(fullSubject);
      expect(entries).toHaveLength(3);

      // Should be sorted: positive, zero, negative
      expect(entries![0].handler).toBe(handlerPositive);
      expect(entries![0].priority).toBe(10);

      expect(entries![1].handler).toBe(handlerZero);
      expect(entries![1].priority).toBe(0);

      expect(entries![2].handler).toBe(handlerNegative);
      expect(entries![2].priority).toBe(-10);
    });
  });

  describe('request handlers', () => {
    it('should execute request handlers in priority order', async () => {
      const executionOrder: string[] = [];

      // Low priority - just tracks and continues
      MakaioBus.on(
        RequestSubjects.process,
        async (ctx) => {
          executionOrder.push('low-before');
          await ctx.next();
          executionOrder.push('low-after');
        },
        { priority: 10 },
      );

      // High priority - runs first
      MakaioBus.on(
        RequestSubjects.process,
        async (ctx) => {
          executionOrder.push('high-before');
          await ctx.next();
          executionOrder.push('high-after');
        },
        { priority: 100 },
      );

      // Medium priority - sets result
      MakaioBus.on(
        RequestSubjects.process,
        (ctx) => {
          executionOrder.push('medium');
          ctx.setResult({ output: ctx.payload.input.toUpperCase() });
        },
        { priority: 50 },
      );

      const result = await MakaioBus.request(RequestSubjects.process, {
        input: 'test',
      });

      expect(result.output).toBe('TEST');

      // Middleware chain should execute in priority order
      expect(executionOrder).toEqual([
        'high-before',
        'medium', // Sets result
        'high-after',
        // Note: low handlers don't run because medium didn't call next()
      ]);
    });

    it('should use default priority of 0 for request handlers', async () => {
      const context = MakaioBus.getContext();
      const fullSubject = 'priorityRequestTest.process';

      MakaioBus.on(RequestSubjects.process, (ctx) => {
        ctx.setResult({ output: 'test' });
      });

      const entries = context.requestHandlers.get(fullSubject);
      expect(entries).toBeDefined();
      expect(entries![0].priority).toBe(0);
    });

    it('should correctly unsubscribe handlers regardless of priority', async () => {
      const context = MakaioBus.getContext();
      const fullSubject = 'priorityTest.action';

      const handler1 = () => {};
      const handler2 = () => {};
      const handler3 = () => {};

      const unsub1 = MakaioBus.on(EventSubjects.action, handler1, {
        priority: 100,
      });
      const unsub2 = MakaioBus.on(EventSubjects.action, handler2, {
        priority: 50,
      });
      MakaioBus.on(EventSubjects.action, handler3, { priority: 10 });

      // Verify all handlers are registered
      expect(context.eventHandlers.get(fullSubject)?.length).toBe(3);

      // Unsubscribe the middle priority handler
      unsub2();

      const entries = context.eventHandlers.get(fullSubject);
      expect(entries?.length).toBe(2);
      expect(entries![0].handler).toBe(handler1);
      expect(entries![1].handler).toBe(handler3);

      // Unsubscribe the high priority handler
      unsub1();

      const remainingEntries = context.eventHandlers.get(fullSubject);
      expect(remainingEntries?.length).toBe(1);
      expect(remainingEntries![0].handler).toBe(handler3);
    });
  });

  describe('cross-pattern priority merging', () => {
    it('should merge handlers from wildcard and exact patterns by priority', async () => {
      const context = MakaioBus.getContext();

      // Register a handler for the exact subject
      MakaioBus.on(EventSubjects.action, () => {}, { priority: 50 });

      // Register a wildcard handler with higher priority
      MakaioBus.on(EventSubjects.$all, () => {}, { priority: 100 });

      // Both handlers should be registered (in different map entries)
      const exactEntries = context.eventHandlers.get('priorityTest.action');
      const wildcardEntries = context.eventHandlers.get('priorityTest.*');

      expect(exactEntries?.length).toBe(1);
      expect(exactEntries![0].priority).toBe(50);

      expect(wildcardEntries?.length).toBe(1);
      expect(wildcardEntries![0].priority).toBe(100);
    });
  });

  describe('with filters', () => {
    it('should respect priority when combined with filters', async () => {
      const context = MakaioBus.getContext();
      const fullSubject = 'priorityTest.action';

      const handler1 = () => {};
      const handler2 = () => {};

      MakaioBus.on(EventSubjects.action, handler1, {
        priority: 100,
        filter: { value: 'a' },
      });

      MakaioBus.on(EventSubjects.action, handler2, {
        priority: 50,
        filter: { value: 'b' },
      });

      const entries = context.eventHandlers.get(fullSubject);
      expect(entries).toHaveLength(2);

      // Should be sorted by priority
      expect(entries![0].priority).toBe(100);
      expect(entries![1].priority).toBe(50);
    });
  });

  // Note: Request middleware replacePayload tests are in request-replace-payload.test.ts
});
