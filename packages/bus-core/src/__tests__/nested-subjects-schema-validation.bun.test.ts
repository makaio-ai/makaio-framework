import { describe, it, expect, beforeEach } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';

// Namespace 1: Standard patterns (events + requests, various nesting depths)
const testNamespace = MakaioBus.registerNamespace(
  createBusNamespace('test', {
    // Events - 2-level nesting
    'tool.use': z.object({ toolName: z.string(), args: z.array(z.string()) }),
    // Events - 4-level deep nesting
    'agent.tool.execution.started': z.object({
      agentId: z.string(),
      toolName: z.string(),
      timestamp: z.number(),
    }),
    // Events - for scoped bus testing
    'stream.chunk': z.object({ content: z.string(), sequenceId: z.number() }),
    'stream.complete': z.object({ totalChunks: z.number() }),
    // Requests - basic request/response
    'test.create': {
      request: z.object({ taskName: z.string(), priority: z.number() }),
      response: z.object({ taskId: z.string(), created: z.boolean() }),
    },
    // Requests - with optional field
    'user.profile.get': {
      request: z.object({
        userId: z.string(),
        includeMetadata: z.boolean().optional(),
      }),
      response: z.object({ username: z.string(), email: z.string() }),
    },
  }),
);

const { subjects: TestSubjects } = testNamespace;

// Namespace 2: Hierarchical namespace (colon delimiter)
const { subjects: AdapterSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('adapter:validation', {
    'tool.execute': z.object({
      tool: z.string(),
      params: z.object({ command: z.string() }),
    }),
  }),
);

/**
 * Tests for nested subject names with schema validation.
 *
 * Coverage:
 * - Nested subjects at various depths (2-level, 4-level)
 * - Event and request schemas
 * - Hierarchical namespaces with colons
 * - Scoped bus namespace isolation
 * - Runtime validation and type inference
 */
describe('Nested Subjects - Schema Validation', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('schema registration and lookup', () => {
    it('registers and retrieves schemas for nested subjects at all depths', () => {
      // 2-level event
      const schema1 = MakaioBus.getSchema(TestSubjects.tool.use);
      expect(schema1).toBeDefined();
      expect((schema1 as z.ZodType).safeParse({ toolName: 'bash', args: ['ls'] }).success).toBe(true);
      expect((schema1 as z.ZodType).safeParse({ toolName: 123, args: ['ls'] }).success).toBe(false);

      // 4-level deep event
      const schema2 = MakaioBus.getSchema(TestSubjects.agent.tool.execution.started);
      expect(schema2).toBeDefined();
      expect(
        (schema2 as z.ZodType).safeParse({
          agentId: 'agent-1',
          toolName: 'bash',
          timestamp: Date.now(),
        }).success,
      ).toBe(true);
      expect(
        (schema2 as z.ZodType).safeParse({
          agentId: 'agent-1',
          toolName: 123,
          timestamp: Date.now(),
        }).success,
      ).toBe(false);

      // Nested request schema
      const requestSchema = MakaioBus.getSchema(TestSubjects.test.create);
      expect(requestSchema).toBeDefined();
      expect(requestSchema).toHaveProperty('request');
      expect(requestSchema).toHaveProperty('response');

      const { request: reqSchema, response: resSchema } = requestSchema as {
        request: z.ZodType;
        response: z.ZodType;
      };
      expect(reqSchema.safeParse({ taskName: 'test', priority: 1 }).success).toBe(true);
      expect(reqSchema.safeParse({ taskName: 'test' }).success).toBe(false);
      expect(resSchema.safeParse({ taskId: 'task-123', created: true }).success).toBe(true);
      expect(resSchema.safeParse({ taskId: 123, created: 'yes' }).success).toBe(false);
    });

    it('handles hierarchical namespace schemas with colons', () => {
      const schema = MakaioBus.getSchema(AdapterSubjects.tool.execute);
      expect(schema).toBeDefined();
      expect((schema as z.ZodType).safeParse({ tool: 'bash', params: { command: 'ls' } }).success).toBe(true);
      expect((schema as z.ZodType).safeParse({ tool: 123, params: { command: 'ls' } }).success).toBe(false);
    });
  });

  describe('runtime validation', () => {
    it('validates event payloads through emit/on with nested subjects', async () => {
      const received: Array<{ toolName: string; args: string[] }> = [];

      MakaioBus.on(TestSubjects.tool.use, ({ payload }) => {
        // Type inference - accessing nested properties
        const toolNameUpper = payload.toolName.toUpperCase();
        const argsLength = payload.args.length;
        expect(typeof toolNameUpper).toBe('string');
        expect(typeof argsLength).toBe('number');

        received.push(payload);
      });

      await MakaioBus.emit(TestSubjects.tool.use, {
        toolName: 'bash',
        args: ['ls', '-la'],
      });

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ toolName: 'bash', args: ['ls', '-la'] });
    });

    it('validates request/response payloads with optional fields', async () => {
      MakaioBus.on(TestSubjects.user.profile.get, (context) => {
        if (context.isRequest) {
          // Type inference on nested request payload
          const userIdLength = context.payload.userId.length;
          const includeMetadata = context.payload.includeMetadata ?? false;
          expect(typeof userIdLength).toBe('number');
          expect(typeof includeMetadata).toBe('boolean');

          context.setResult({
            username: 'test-user',
            email: 'test@example.com',
          });
        }
      });

      // Without optional field
      const result1 = await MakaioBus.request(TestSubjects.user.profile.get, {
        userId: 'user-123',
      });
      expect(result1).toEqual({ username: 'test-user', email: 'test@example.com' });

      // With optional field
      const result2 = await MakaioBus.request(TestSubjects.user.profile.get, {
        userId: 'user-456',
        includeMetadata: true,
      });
      expect(result2).toEqual({ username: 'test-user', email: 'test@example.com' });
    });

    it('prevents emitting to request subjects', async () => {
      await expect(
        // @ts-expect-error - emitting a request should error at compile-time
        MakaioBus.emit(TestSubjects.test.create, {
          taskName: 'test',
          priority: 1,
        }),
      ).rejects.toThrow('Cannot emit to request subjects. Use event subjects only.');
    });
  });

  describe('scoped bus namespace isolation', () => {
    it('validates subjects within scoped namespace and rejects cross-namespace access', async () => {
      const scopedBus = MakaioBus.scoped(testNamespace);
      const received: Array<{ content: string; sequenceId: number }> = [];

      // @ts-expect-error - verify namespace inference
      const _ns: 'wrongNamespace' = scopedBus.namespace;

      scopedBus.on(TestSubjects.stream.chunk, ({ payload }) => {
        // Type inference in scoped context
        const contentLength = payload.content.length;
        const sequenceIdPlusOne = payload.sequenceId + 1;
        expect(typeof contentLength).toBe('number');
        expect(typeof sequenceIdPlusOne).toBe('number');

        received.push(payload);
      });

      await scopedBus.emit(TestSubjects.stream.chunk, {
        content: 'hello',
        sequenceId: 1,
      });

      // Cannot emit with string subject
      await expect(
        // @ts-expect-error - string subjects not allowed
        scopedBus.emit('stream.chunk', { content: 'world', sequenceId: 2 }),
      ).rejects.toThrow('Invalid subject definition provided to emit()');

      // Cannot emit to different namespace subject
      await expect(
        // @ts-expect-error - cross-namespace not allowed
        scopedBus.emit(AdapterSubjects.tool.execute, {
          tool: 'bash',
          params: { command: 'ls' },
        }),
      ).rejects.toThrow('Subject namespace adapter:validation does not match scoped bus namespace test');

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({ content: 'hello', sequenceId: 1 });
    });
  });

  describe('type safety and inference', () => {
    it('infers correct payload types from SubjectDefinition at compile-time', async () => {
      const received: Array<{
        agentId: string;
        toolName: string;
        timestamp: number;
      }> = [];

      MakaioBus.on(TestSubjects.agent.tool.execution.started, ({ payload }) => {
        // These operations prove compile-time type safety
        const agentIdUpper = payload.agentId.toUpperCase();
        const toolNameLength = payload.toolName.length;
        const timestampPlusOne = payload.timestamp + 1;

        expect(typeof agentIdUpper).toBe('string');
        expect(typeof toolNameLength).toBe('number');
        expect(typeof timestampPlusOne).toBe('number');

        received.push(payload);
      });

      await MakaioBus.emit(TestSubjects.agent.tool.execution.started, {
        agentId: 'agent-1',
        toolName: 'bash',
        timestamp: Date.now(),
      });

      expect(received).toHaveLength(1);
      expect(received[0].agentId).toBe('agent-1');
    });
  });
});
