import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';

const { subjects: TestSubjects } = MakaioBus.registerNamespace('interceptTest', {
  action: z.object({ value: z.string() }),
});

describe('bus.intercept()', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('should have intercept method on bus', () => {
    expect(typeof MakaioBus.intercept).toBe('function');
  });

  it('should have interceptorHandlers in context', () => {
    const context = MakaioBus.getContext();
    expect(context.interceptorHandlers).toBeInstanceOf(Map);
  });

  describe('intercept registration', () => {
    it('should register an interceptor and return unsubscribe function', () => {
      const handler = vi.fn();
      const unsubscribe = MakaioBus.intercept(TestSubjects.action, handler);

      expect(typeof unsubscribe).toBe('function');

      const context = MakaioBus.getContext();
      const entries = context.interceptorHandlers.get('interceptTest.action');
      expect(entries).toHaveLength(1);

      unsubscribe();
      expect(context.interceptorHandlers.get('interceptTest.action')).toBeUndefined();
    });

    it('should sort interceptors by priority (highest first)', () => {
      const lowHandler = vi.fn();
      const highHandler = vi.fn();
      const medHandler = vi.fn();

      MakaioBus.intercept(TestSubjects.action, lowHandler, { priority: 10 });
      MakaioBus.intercept(TestSubjects.action, highHandler, { priority: 100 });
      MakaioBus.intercept(TestSubjects.action, medHandler, { priority: 50 });

      const context = MakaioBus.getContext();
      const entries = context.interceptorHandlers.get('interceptTest.action')!;

      expect(entries[0].handler).toBe(highHandler);
      expect(entries[1].handler).toBe(medHandler);
      expect(entries[2].handler).toBe(lowHandler);
    });

    it('should preserve registration order for equal priorities (FIFO)', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      MakaioBus.intercept(TestSubjects.action, handler1, { priority: 50 });
      MakaioBus.intercept(TestSubjects.action, handler2, { priority: 50 });
      MakaioBus.intercept(TestSubjects.action, handler3, { priority: 50 });

      const context = MakaioBus.getContext();
      const entries = context.interceptorHandlers.get('interceptTest.action')!;

      expect(entries[0].handler).toBe(handler1);
      expect(entries[1].handler).toBe(handler2);
      expect(entries[2].handler).toBe(handler3);
    });

    it('should use default priority of 0', () => {
      const handler = vi.fn();
      MakaioBus.intercept(TestSubjects.action, handler);

      const context = MakaioBus.getContext();
      const entries = context.interceptorHandlers.get('interceptTest.action')!;

      expect(entries[0].priority).toBe(0);
    });

    it('should handle negative priorities', () => {
      const handlerNegative = vi.fn();
      const handlerZero = vi.fn();
      const handlerPositive = vi.fn();

      MakaioBus.intercept(TestSubjects.action, handlerNegative, {
        priority: -10,
      });
      MakaioBus.intercept(TestSubjects.action, handlerZero);
      MakaioBus.intercept(TestSubjects.action, handlerPositive, { priority: 10 });

      const context = MakaioBus.getContext();
      const entries = context.interceptorHandlers.get('interceptTest.action')!;

      expect(entries[0].handler).toBe(handlerPositive);
      expect(entries[0].priority).toBe(10);

      expect(entries[1].handler).toBe(handlerZero);
      expect(entries[1].priority).toBe(0);

      expect(entries[2].handler).toBe(handlerNegative);
      expect(entries[2].priority).toBe(-10);
    });

    it('should correctly unsubscribe from middle of array', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const handler3 = vi.fn();

      MakaioBus.intercept(TestSubjects.action, handler1, { priority: 100 });
      const unsub2 = MakaioBus.intercept(TestSubjects.action, handler2, {
        priority: 50,
      });
      MakaioBus.intercept(TestSubjects.action, handler3, { priority: 10 });

      const context = MakaioBus.getContext();
      expect(context.interceptorHandlers.get('interceptTest.action')).toHaveLength(3);

      unsub2();

      const entries = context.interceptorHandlers.get('interceptTest.action')!;
      expect(entries).toHaveLength(2);
      expect(entries[0].handler).toBe(handler1);
      expect(entries[1].handler).toBe(handler3);
    });
  });

  describe('interceptor execution', () => {
    it('should run interceptors before handlers', async () => {
      const order: string[] = [];

      MakaioBus.intercept(TestSubjects.action, () => {
        order.push('interceptor');
      });

      MakaioBus.on(TestSubjects.action, () => {
        order.push('handler');
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(order).toEqual(['interceptor', 'handler']);
    });

    it('should run interceptors sequentially in priority order', async () => {
      const order: string[] = [];

      MakaioBus.intercept(
        TestSubjects.action,
        () => {
          order.push('low');
        },
        { priority: 10 },
      );

      MakaioBus.intercept(
        TestSubjects.action,
        () => {
          order.push('high');
        },
        { priority: 100 },
      );

      MakaioBus.intercept(
        TestSubjects.action,
        () => {
          order.push('medium');
        },
        { priority: 50 },
      );

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(order).toEqual(['high', 'medium', 'low']);
    });

    it('should pass correct context to interceptors', async () => {
      let receivedCtx: unknown;

      MakaioBus.intercept(TestSubjects.action, (ctx) => {
        receivedCtx = ctx;
      });

      await MakaioBus.emit(
        TestSubjects.action,
        { value: 'test' },
        {
          messageId: 'msg-123',
          correlationId: 'corr-456',
        },
      );

      const ctx = receivedCtx as {
        subject: string;
        payload: unknown;
        messageId: string;
        correlationId: string;
        stopPropagation: () => void;
        replacePayload: (p: unknown) => void;
        next: () => void;
      };
      expect(ctx.subject).toBe('interceptTest.action');
      expect(ctx.payload).toEqual({ value: 'test' });
      expect(ctx.messageId).toBe('msg-123');
      expect(ctx.correlationId).toBe('corr-456');
      expect(typeof ctx.stopPropagation).toBe('function');
      expect(typeof ctx.replacePayload).toBe('function');
      expect(typeof ctx.next).toBe('function');
    });

    it('should allow replacePayload() to transform payload for subsequent interceptors', async () => {
      const payloads: unknown[] = [];

      MakaioBus.intercept(
        TestSubjects.action,
        (ctx) => {
          payloads.push({ ...ctx.payload });
          ctx.replacePayload({ value: 'transformed-1' });
        },
        { priority: 100 },
      );

      MakaioBus.intercept(
        TestSubjects.action,
        (ctx) => {
          payloads.push({ ...ctx.payload });
          ctx.replacePayload({ value: 'transformed-2' });
        },
        { priority: 50 },
      );

      let handlerPayload: unknown;
      MakaioBus.on(TestSubjects.action, (ctx) => {
        handlerPayload = ctx.payload;
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'original' });

      expect(payloads).toEqual([{ value: 'original' }, { value: 'transformed-1' }]);
      expect(handlerPayload).toEqual({ value: 'transformed-2' });
    });

    it('should allow stopPropagation() to prevent handlers from running', async () => {
      const handlerCalled = vi.fn();

      MakaioBus.intercept(TestSubjects.action, (ctx) => {
        ctx.stopPropagation();
      });

      MakaioBus.on(TestSubjects.action, handlerCalled);

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(handlerCalled).not.toHaveBeenCalled();
    });

    it('should skip remaining interceptors after stopPropagation()', async () => {
      const order: string[] = [];

      MakaioBus.intercept(
        TestSubjects.action,
        (ctx) => {
          order.push('first');
          ctx.stopPropagation();
        },
        { priority: 100 },
      );

      MakaioBus.intercept(
        TestSubjects.action,
        () => {
          order.push('second'); // Should NOT run
        },
        { priority: 50 },
      );

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(order).toEqual(['first']);
    });

    it('should handle async interceptors', async () => {
      const order: string[] = [];

      MakaioBus.intercept(TestSubjects.action, async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('async');
      });

      MakaioBus.on(TestSubjects.action, () => {
        order.push('handler');
      });

      await MakaioBus.emit(TestSubjects.action, { value: 'test' });

      expect(order).toEqual(['async', 'handler']);
    });

    it('should fail fast on interceptor errors', async () => {
      const secondInterceptor = vi.fn();
      const handler = vi.fn();

      MakaioBus.intercept(
        TestSubjects.action,
        () => {
          throw new Error('Interceptor failed');
        },
        { priority: 100 },
      );

      MakaioBus.intercept(TestSubjects.action, secondInterceptor, { priority: 50 });
      MakaioBus.on(TestSubjects.action, handler);

      await expect(MakaioBus.emit(TestSubjects.action, { value: 'test' })).rejects.toThrow('Interceptor failed');

      expect(secondInterceptor).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

const scopedInterceptNamespace = MakaioBus.registerNamespace('scopedIntercept', {
  event: z.object({ data: z.string() }),
});

describe('scoped bus intercept', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('should support intercept on scoped bus', async () => {
    const scopedBus = MakaioBus.scoped(scopedInterceptNamespace);
    const called = vi.fn();

    scopedBus.intercept(scopedInterceptNamespace.subjects.event, called);

    await MakaioBus.emit(scopedInterceptNamespace.subjects.event, { data: 'test' });

    expect(called).toHaveBeenCalled();
  });

  it('should respect base filter on filtered bus intercept', async () => {
    const filteredBus = MakaioBus.scoped(scopedInterceptNamespace).withFilter({ data: 'test' });
    const called = vi.fn();

    filteredBus.intercept(scopedInterceptNamespace.subjects.event, called);

    // Should NOT be called - payload doesn't match filter
    await MakaioBus.emit(scopedInterceptNamespace.subjects.event, { data: 'other' });
    expect(called).not.toHaveBeenCalled();

    // Should be called - payload matches filter
    await MakaioBus.emit(scopedInterceptNamespace.subjects.event, { data: 'test' });
    expect(called).toHaveBeenCalledTimes(1);
  });
});

describe('filtered bus intercept', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('should support intercept on filtered bus', async () => {
    const filteredBus = MakaioBus.scoped(scopedInterceptNamespace).withFilter({ data: 'test' });
    const called = vi.fn();

    filteredBus.intercept(scopedInterceptNamespace.subjects.event, called);

    await MakaioBus.emit(scopedInterceptNamespace.subjects.event, { data: 'test' });

    expect(called).toHaveBeenCalled();
  });
});
