import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';
import { createAdapterNamespace } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';

/**
 * Unit tests for createAdapterNamespace factory function.
 *
 * Tests the namespace creation, subject token generation, and type safety
 * of the adapter namespace system. Does not test bus integration.
 */

// Shared test fixtures
const createStandardNamespace = () =>
  createAdapterNamespace('adapter:test', {
    thinking: z.object({ content: z.string() }),
    'tool.use': z.object({ toolId: z.string() }),
    status: z.object({ code: z.number() }),
    getContext: {
      request: z.object({ sessionId: z.string() }),
      response: z.object({ context: z.string() }),
    },
  });

const createMultiLevelNestedNamespace = () =>
  createAdapterNamespace('adapter:test', {
    'system.memory.update': z.object({ value: z.string() }),
    'system.cache.clear': z.object({ all: z.boolean() }),
  });

describe('createAdapterNamespace', () => {
  beforeEach(() => {
    // Reset namespace registry to ensure tests are independent
    MakaioBus.getContext().namespaceRegistry.__resetNamespaces?.();
  });

  describe('Namespace Structure', () => {
    it('should create namespace with correct structure', () => {
      const namespace = createStandardNamespace();

      expect(namespace).toHaveProperty('name');
      expect(namespace).toHaveProperty('subjects');
    });

    it('should use provided namespace prefix', () => {
      const namespace = createAdapterNamespace('adapter:myAdapter', {
        event: z.object({ data: z.string() }),
      });

      expect(namespace.name).toBe('adapter:myAdapter');
    });

    it('should support type-safe subject access', () => {
      const namespace = createStandardNamespace();

      expect(namespace.subjects.thinking).toBeDefined();
      expect(namespace.subjects.thinking).toMatchObject({
        subject: 'thinking',
        $meta: { namespace: 'adapter:test' },
      });
    });
  });

  describe('Simple Event Subjects', () => {
    let namespace: ReturnType<typeof createStandardNamespace>;

    beforeEach(() => {
      namespace = createStandardNamespace();
    });

    it('should create subject token for simple event', () => {
      expect(namespace.subjects.thinking).toMatchObject({
        subject: 'thinking',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
    });

    it('should create tokens for multiple simple events', () => {
      expect(namespace.subjects.thinking).toMatchObject({
        subject: 'thinking',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
      expect(namespace.subjects.status).toMatchObject({
        subject: 'status',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
    });

    it('should handle different schema types', () => {
      const ns = createAdapterNamespace('adapter:schemas', {
        simpleString: z.string(),
        complexObject: z.object({ nested: z.object({ value: z.string() }) }),
        arraySchema: z.array(z.string()),
      });

      expect(ns.subjects.simpleString).toMatchObject({
        subject: 'simpleString',
        $meta: { namespace: 'adapter:schemas', isRequest: false },
      });
      expect(ns.subjects.complexObject).toMatchObject({
        subject: 'complexObject',
        $meta: { namespace: 'adapter:schemas', isRequest: false },
      });
      expect(ns.subjects.arraySchema).toMatchObject({
        subject: 'arraySchema',
        $meta: { namespace: 'adapter:schemas', isRequest: false },
      });
    });
  });

  describe('Nested Subject Names', () => {
    it('should handle dotted subject names', () => {
      const namespace = createStandardNamespace();

      expect(namespace.subjects.tool.use).toMatchObject({
        subject: 'tool.use',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
    });

    it('should handle multiple levels of nesting', () => {
      const namespace = createMultiLevelNestedNamespace();

      expect(namespace.subjects.system.memory.update).toMatchObject({
        subject: 'system.memory.update',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
      expect(namespace.subjects.system.cache.clear).toMatchObject({
        subject: 'system.cache.clear',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
    });

    it('should mix simple and dotted subject names', () => {
      const namespace = createStandardNamespace();

      expect(namespace.subjects.thinking).toMatchObject({
        subject: 'thinking',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
      expect(namespace.subjects.tool.use).toMatchObject({
        subject: 'tool.use',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
      expect(namespace.subjects.status).toMatchObject({
        subject: 'status',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
    });
  });

  describe('Request/Response Pairs', () => {
    it('should create subject token for request/response pair', () => {
      const namespace = createStandardNamespace();

      expect(namespace.subjects.getContext).toMatchObject({
        subject: 'getContext',
        $meta: { namespace: 'adapter:test', isRequest: true },
      });
    });

    it('should handle multiple request/response pairs', () => {
      const namespace = createAdapterNamespace('adapter:test', {
        getContext: {
          request: z.object({ sessionId: z.string() }),
          response: z.object({ context: z.string() }),
        },
        getStatus: {
          request: z.object({ id: z.string() }),
          response: z.object({ status: z.string() }),
        },
      });

      expect(namespace.subjects.getContext).toMatchObject({
        subject: 'getContext',
        $meta: { namespace: 'adapter:test', isRequest: true },
      });
      expect(namespace.subjects.getStatus).toMatchObject({
        subject: 'getStatus',
        $meta: { namespace: 'adapter:test', isRequest: true },
      });
    });

    it('should mix events and request/response pairs', () => {
      const namespace = createStandardNamespace();

      expect(namespace.subjects.thinking).toMatchObject({
        subject: 'thinking',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
      expect(namespace.subjects.getContext).toMatchObject({
        subject: 'getContext',
        $meta: { namespace: 'adapter:test', isRequest: true },
      });
      expect(namespace.subjects.status).toMatchObject({
        subject: 'status',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
    });

    it('should handle request/response with nested subject names', () => {
      const namespace = createAdapterNamespace('adapter:test', {
        'system.getConfig': {
          request: z.object({ key: z.string() }),
          response: z.object({ value: z.record(z.string(), z.unknown()) }),
        },
      });

      expect(namespace.subjects.system.getConfig).toMatchObject({
        subject: 'system.getConfig',
        $meta: { namespace: 'adapter:test', isRequest: true },
      });
    });
  });

  describe('Subject Token Format', () => {
    it('should prefix tokens with namespace', () => {
      const namespace = createAdapterNamespace('adapter:custom', {
        event: z.object({ data: z.string() }),
      });

      expect(namespace.subjects.event.$meta.namespace).toBe('adapter:custom');
    });

    it('should use dot separator between namespace and subject', () => {
      const namespace = createAdapterNamespace('adapter:test', {
        myEvent: z.object({ data: z.string() }),
      });

      expect(namespace.subjects.myEvent).toMatchObject({
        subject: 'myEvent',
        $meta: { namespace: 'adapter:test' },
      });
      expect(namespace.subjects.myEvent.subject).not.toContain(':');
    });

    it('should maintain subject name case', () => {
      const namespace = createAdapterNamespace('adapter:test', {
        MyEvent: z.object({ data: z.string() }),
        myEvent: z.object({ data: z.string() }),
        MYEVENT: z.object({ data: z.string() }),
      });

      expect(namespace.subjects.MyEvent.subject).toBe('MyEvent');
      expect(namespace.subjects.myEvent.subject).toBe('myEvent');
      expect(namespace.subjects.MYEVENT.subject).toBe('MYEVENT');
    });
  });

  describe('Edge Cases', () => {
    it('should handle namespace with no subjects', () => {
      const namespace = createAdapterNamespace('adapter:empty', {});

      expect(namespace.name).toBe('adapter:empty');
      expect(namespace.subjects).toHaveProperty('$all');
      expect(Object.keys(namespace.subjects)).toHaveLength(1);
    });

    it('should handle namespace with single subject', () => {
      const namespace = createAdapterNamespace('adapter:single', {
        onlyEvent: z.object({ data: z.string() }),
      });

      expect(namespace.subjects.onlyEvent).toMatchObject({
        subject: 'onlyEvent',
        $meta: { namespace: 'adapter:single', isRequest: false },
      });
      expect(Object.keys(namespace.subjects)).toHaveLength(2);
    });

    it('should handle complex schemas and transformations', () => {
      const complexNs = createAdapterNamespace('adapter:complex', {
        complexEvent: z.object({
          metadata: z.object({ timestamp: z.number(), tags: z.array(z.string()) }),
          payload: z.union([z.string(), z.number(), z.record(z.string(), z.unknown())]),
          optional: z.string().optional(),
        }),
      });
      const transformNs = createAdapterNamespace('adapter:transform', {
        withDefaults: z
          .object({ value: z.string().default('default'), count: z.number().default(0) })
          .transform((val) => val),
      });

      expect(complexNs.subjects.complexEvent).toMatchObject({
        subject: 'complexEvent',
        $meta: { namespace: 'adapter:complex', isRequest: false },
      });
      expect(transformNs.subjects.withDefaults).toMatchObject({
        subject: 'withDefaults',
        $meta: { namespace: 'adapter:transform', isRequest: false },
      });
    });
  });

  describe('Multiple Namespaces', () => {
    it('should create independent namespaces', () => {
      const namespace1 = createAdapterNamespace('adapter:first', {
        event: z.object({ data: z.string() }),
      });
      const namespace2 = createAdapterNamespace('adapter:second', {
        event: z.object({ data: z.string() }),
      });

      expect(namespace1.subjects.event.$meta.namespace).toBe('adapter:first');
      expect(namespace2.subjects.event.$meta.namespace).toBe('adapter:second');
      expect(namespace1.subjects.event).not.toBe(namespace2.subjects.event);
    });

    it('should maintain separate subject lists', () => {
      const namespace1 = createAdapterNamespace('adapter:one', {
        eventA: z.object({ data: z.string() }),
      });
      const namespace2 = createAdapterNamespace('adapter:two', {
        eventB: z.object({ data: z.string() }),
      });

      expect(namespace1.subjects).toHaveProperty('eventA');
      expect(namespace1.subjects).not.toHaveProperty('eventB');
      expect(namespace2.subjects).toHaveProperty('eventB');
      expect(namespace2.subjects).not.toHaveProperty('eventA');
    });
  });

  describe('Real-world Usage Patterns', () => {
    it('should support comprehensive adapter namespace', () => {
      const namespace = createStandardNamespace();

      expect(namespace.subjects.thinking).toMatchObject({
        subject: 'thinking',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
      expect(namespace.subjects.tool.use).toMatchObject({
        subject: 'tool.use',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });
      expect(namespace.subjects.getContext).toMatchObject({
        subject: 'getContext',
        $meta: { namespace: 'adapter:test', isRequest: true },
      });
      expect(Object.keys(namespace.subjects)).toHaveLength(5);
    });

    it('should support AI adapter event patterns', () => {
      const namespace = createAdapterNamespace('adapter:ai', {
        'prompt.start': z.object({ promptId: z.string(), text: z.string() }),
        'prompt.complete': z.object({ promptId: z.string(), result: z.string() }),
        'stream.chunk': z.object({ content: z.string(), done: z.boolean() }),
        getModel: {
          request: z.record(z.string(), z.unknown()),
          response: z.object({ model: z.string(), version: z.string() }),
        },
      });

      expect(namespace.subjects.prompt.start).toMatchObject({
        subject: 'prompt.start',
        $meta: { namespace: 'adapter:ai', isRequest: false },
      });
      expect(namespace.subjects.prompt.complete).toMatchObject({
        subject: 'prompt.complete',
        $meta: { namespace: 'adapter:ai', isRequest: false },
      });
      expect(namespace.subjects.stream.chunk).toMatchObject({
        subject: 'stream.chunk',
        $meta: { namespace: 'adapter:ai', isRequest: false },
      });
      expect(namespace.subjects.getModel).toMatchObject({
        subject: 'getModel',
        $meta: { namespace: 'adapter:ai', isRequest: true },
      });
    });
  });

  describe('Subject Access Patterns', () => {
    it('should allow dot access and enumerate keys', () => {
      const namespace = createStandardNamespace();

      expect(namespace.subjects.thinking).toMatchObject({
        subject: 'thinking',
        $meta: { namespace: 'adapter:test', isRequest: false },
      });

      const keys = Object.keys(namespace.subjects);
      expect(keys).toContain('thinking');
      expect(keys).toContain('tool');
      expect(keys).toContain('status');
      expect(keys).toContain('getContext');
      expect(keys).toContain('$all');
    });
  });
});
