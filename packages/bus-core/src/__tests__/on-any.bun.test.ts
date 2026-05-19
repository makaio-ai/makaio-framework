import { describe, it, expect, beforeEach } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace, type AnyMessageContext } from '@makaio/core';

describe('__onAny', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('event tracking', () => {
    it('captures all events across namespaces', async () => {
      const namespace1 = MakaioBus.registerNamespace(
        createBusNamespace('testOnAny:ns1', {
          event1: z.object({ value: z.number() }),
        }),
      );

      const namespace2 = MakaioBus.registerNamespace(
        createBusNamespace('testOnAny:ns2', {
          event2: z.object({ text: z.string() }),
        }),
      );

      const captured: AnyMessageContext[] = [];
      MakaioBus.__onAny((ctx) => {
        captured.push(ctx);
      });

      await MakaioBus.emit(namespace1.subjects.event1, { value: 42 });
      await MakaioBus.emit(namespace2.subjects.event2, { text: 'hello' });

      expect(captured).toHaveLength(2);
      expect(captured[0]).toMatchObject({
        type: 'event',
        subject: 'testOnAny:ns1.event1',
        namespace: 'testOnAny:ns1',
        payload: { value: 42 },
      });
      expect(captured[1]).toMatchObject({
        type: 'event',
        subject: 'testOnAny:ns2.event2',
        namespace: 'testOnAny:ns2',
        payload: { text: 'hello' },
      });
    });

    it('fires even when no regular handlers registered', async () => {
      const namespace = MakaioBus.registerNamespace(
        createBusNamespace('testOnAny:orphan', {
          orphanEvent: z.object({ id: z.string() }),
        }),
      );

      const captured: AnyMessageContext[] = [];
      MakaioBus.__onAny((ctx) => {
        captured.push(ctx);
      });

      await MakaioBus.emit(namespace.subjects.orphanEvent, { id: 'test-123' });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.payload).toEqual({ id: 'test-123' });
    });
  });

  describe('request tracking', () => {
    it('captures all requests', async () => {
      const namespace = MakaioBus.registerNamespace(
        createBusNamespace('testOnAny:req', {
          compute: {
            request: z.object({ input: z.number() }),
            response: z.object({ result: z.number() }),
          },
        }),
      );

      const captured: AnyMessageContext[] = [];
      MakaioBus.__onAny((ctx) => {
        captured.push(ctx);
      });

      MakaioBus.on(namespace.subjects.compute, (ctx) => {
        ctx.setResult({ result: ctx.payload.input * 2 });
      });

      const result = await MakaioBus.request(namespace.subjects.compute, { input: 21 });

      expect(result).toEqual({ result: 42 });
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        type: 'request',
        subject: 'compute',
        namespace: 'testOnAny:req',
        payload: { input: 21 },
      });
    });
  });

  describe('unsubscribe', () => {
    it('returns working unsubscribe function', async () => {
      const namespace = MakaioBus.registerNamespace(
        createBusNamespace('testOnAny:unsub', {
          tick: z.object({ count: z.number() }),
        }),
      );

      const captured: AnyMessageContext[] = [];
      const unsubscribe = MakaioBus.__onAny((ctx) => {
        captured.push(ctx);
      });

      await MakaioBus.emit(namespace.subjects.tick, { count: 1 });
      expect(captured).toHaveLength(1);

      unsubscribe();

      await MakaioBus.emit(namespace.subjects.tick, { count: 2 });
      expect(captured).toHaveLength(1); // Should not capture second event
    });
  });

  describe('multiple handlers', () => {
    it('invokes all registered __onAny handlers', async () => {
      const namespace = MakaioBus.registerNamespace(
        createBusNamespace('testOnAny:multi', {
          signal: z.object({ id: z.string() }),
        }),
      );

      const captured1: AnyMessageContext[] = [];
      const captured2: AnyMessageContext[] = [];

      MakaioBus.__onAny((ctx) => {
        captured1.push(ctx);
      });
      MakaioBus.__onAny((ctx) => {
        captured2.push(ctx);
      });

      await MakaioBus.emit(namespace.subjects.signal, { id: 'test' });

      expect(captured1).toHaveLength(1);
      expect(captured2).toHaveLength(1);
      expect(captured1[0]?.payload).toEqual({ id: 'test' });
      expect(captured2[0]?.payload).toEqual({ id: 'test' });
    });
  });

  describe('metadata', () => {
    it('includes messageId and correlationId', async () => {
      const namespace = MakaioBus.registerNamespace(
        createBusNamespace('testOnAny:meta', {
          trace: z.object({ step: z.string() }),
        }),
      );

      const captured: AnyMessageContext[] = [];
      MakaioBus.__onAny((ctx) => {
        captured.push(ctx);
      });

      await MakaioBus.emit(namespace.subjects.trace, { step: 'start' }, { correlationId: 'trace-123' });

      expect(captured).toHaveLength(1);
      expect(captured[0]?.correlationId).toBe('trace-123');
      expect(captured[0]?.messageId).toBeDefined();
      expect(typeof captured[0]?.messageId).toBe('string');
    });
  });
});
