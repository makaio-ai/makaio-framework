/**
 * Type-level tests to verify wildcard method signatures work correctly.
 *
 * These tests verify that:
 * 1. Exact matches are fully typed
 * 2. Wildcard patterns accept unknown payload
 * 3. emit() and request() only accept concrete subjects
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';

// Register test subjects
const { subjects: _TestSubjects } = MakaioBus.registerNamespace('wildcardSignatureTest', {
  log: z.object({ message: z.string() }),
  error: z.object({ error: z.string() }),
  getInfo: {
    request: z.object({ id: z.string() }),
    response: z.object({ data: z.string() }),
  },
});

// Augment BusSubjectsNamespace
declare module '../index.js' {
  interface BusSubjectsNamespace {
    wildcardSignatureTest: typeof _TestSubjects;
  }
}

describe('Wildcard Method Signatures', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('on() with exact match', () => {
    it('should have fully typed event handlers', async () => {
      const received: Array<{ message: string }> = [];

      // ✅ Exact match - context.payload is fully typed
      MakaioBus.on(_TestSubjects.log, (context) => {
        // Type assertion: context.payload should have 'message' property
        received.push({ message: context.payload.message });
      });

      await MakaioBus.emit(_TestSubjects.log, { message: 'test' });

      expect(received).toHaveLength(1);
      expect(received[0].message).toBe('test');
    });

    it('should have fully typed request handlers', async () => {
      // ✅ Exact match - context.payload is fully typed
      MakaioBus.on(_TestSubjects.getInfo, (context) => {
        // Type assertion: context.payload should have 'id' property
        const id = context.payload.id;
        context.setResult({ data: `info-${id}` });
      });

      const result = await MakaioBus.request(_TestSubjects.getInfo, { id: '123' });

      expect(result.data).toBe('info-123');
    });
  });

  describe('on() with wildcards', () => {
    it('should accept event wildcard handlers with unknown payload', async () => {
      const received: unknown[] = [];

      // ✅ Wildcard - context.payload is unknown
      MakaioBus.on(_TestSubjects.$all, (context) => {
        // payload is now separate from context metadata
        received.push(context.payload);
      });

      await MakaioBus.emit(_TestSubjects.log, { message: 'test1' });
      await MakaioBus.emit(_TestSubjects.error, { error: 'test2' });

      expect(received).toHaveLength(2);
    });

    it('should not override event handler for exact subject', async () => {
      const received: unknown[] = [];

      MakaioBus.on(_TestSubjects.$all, (context) => {
        received.push(context.payload);
      });

      MakaioBus.on(_TestSubjects.log, (context) => {
        received.push(context.payload);
      });

      await MakaioBus.emit(_TestSubjects.log, { message: 'test1' });

      expect(received).toHaveLength(2);
    });

    it('should not override request handler for exact subject', async () => {
      const received: unknown[] = [];

      MakaioBus.on(_TestSubjects.$all, (context) => {
        received.push(context.payload);
      });

      MakaioBus.on(_TestSubjects.getInfo, (context) => {
        // intentionally not returning a result, to see if next handler is called
        received.push(context.payload);
      });

      MakaioBus.on(_TestSubjects.getInfo, (context) => {
        received.push(context.payload);
        context.setResult({ data: 'test' });
      });

      await MakaioBus.request(_TestSubjects.getInfo, { id: 'test1' });

      expect(received).toHaveLength(3);
    });

    it('should accept both event and request handlers for wildcards matching both types', async () => {
      const eventPayloads: unknown[] = [];
      const requestPayloads: unknown[] = [];

      // Unified handler that can handle both events and requests (discriminated union)
      const unifiedHandler = MakaioBus.on(_TestSubjects.$all, (context) => {
        if (context.isRequest) {
          // This is a request - context has payload, setResult, and next
          requestPayloads.push(context.payload);
          context.setResult({ data: 'handled' });
        } else {
          // This is an event - context has payload with isRequest: false
          eventPayloads.push(context.payload);
        }
      });

      // Emit an event - should trigger the handler
      await MakaioBus.emit(_TestSubjects.log, { message: 'test event' });

      // Make a request - should trigger the handler
      const result = await MakaioBus.request(_TestSubjects.getInfo, { id: 'test' });

      // Verify handler was called correctly for both
      expect(eventPayloads).toEqual([{ message: 'test event' }]); // Handler got the event
      expect(requestPayloads).toEqual([{ id: 'test' }]); // Handler got the request
      expect(result).toEqual({ data: 'handled' });

      // Cleanup
      unifiedHandler();
    });
  });

  describe('emit() - only concrete subjects', () => {
    it('should accept concrete event subjects', async () => {
      const received: string[] = [];

      MakaioBus.on(_TestSubjects.log, (context) => {
        received.push(context.payload.message);
      });

      // ✅ Concrete subject works
      await MakaioBus.emit(_TestSubjects.log, { message: 'concrete' });

      expect(received).toEqual(['concrete']);
    });

    it('should reject wildcard subjects at compile time', async () => {
      // TypeScript prevents emitting to wildcards at compile time
      // The following line would be a type error if uncommented:
      // @ts-expect-error - Type error: emit() doesn't accept wildcards
      await expect(MakaioBus.emit(_TestSubjects.$all, {})).rejects.toThrow(
        'Emitting wildcard subjects is not allowed. Use concrete subject keys only.',
      );
    });
  });

  describe('request() - only concrete subjects', () => {
    it('should accept concrete request subjects', async () => {
      MakaioBus.on(_TestSubjects.getInfo, (context) => {
        context.setResult({ data: `result-${context.payload.id}` });
      });

      // ✅ Concrete subject works
      const result = await MakaioBus.request(_TestSubjects.getInfo, { id: '789' });

      expect(result.data).toBe('result-789');
    });

    it('should reject wildcard subjects at compile time', async () => {
      // TypeScript prevents requesting via wildcards at compile time
      // The following line would be a type error if uncommented:
      // @ts-expect-error - Type error: request() doesn't accept wildcards
      await expect(MakaioBus.request(_TestSubjects.$all, {})).rejects.toThrow(
        'No handler registered for request subject "wildcardSignatureTest.*"',
      );
    });
  });
});
