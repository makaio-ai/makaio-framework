import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace, type RequestContext } from '@makaio/core';
import { ValidationError } from '../errors/validation-error.js';

// Register all namespaces used in this test file
const { subjects: _Nested1Subjects } = MakaioBus.registerNamespace(
  createBusNamespace('nested1', {
    'tool.use': z.object({ toolName: z.string() }),
    'tool.result': z.object({ output: z.string() }),
  }),
);

const { subjects: _Nested2Subjects } = MakaioBus.registerNamespace(
  createBusNamespace('nested2', {
    'stream.chunk.partial': z.object({ content: z.string() }),
    'stream.chunk.complete': z.object({ content: z.string() }),
  }),
);

const { subjects: _Nested3Subjects } = MakaioBus.registerNamespace(
  createBusNamespace('nested3', {
    'agent.tool.execution.started': z.object({ toolName: z.string() }),
  }),
);

const _ScopedNamespace = MakaioBus.registerNamespace(
  createBusNamespace('scopedNested', {
    'tool.use': z.object({ toolName: z.string() }),
    'stream.chunk.partial': z.object({ content: z.string() }),
  }),
);

const { subjects: _ScopedSubjects } = _ScopedNamespace;

const { subjects: _RequestNestedSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('requestNested', {
    'tool.execute': {
      request: z.object({ toolName: z.string() }),
      response: z.object({ result: z.string() }),
    },
  }),
);

const _ScopedRequestNamespace = MakaioBus.registerNamespace(
  createBusNamespace('scopedRequestNested', {
    'tool.execute': {
      request: z.object({ toolName: z.string() }),
      response: z.object({ result: z.string() }),
    },
  }),
);

const { subjects: _ScopedRequestSubjects } = _ScopedRequestNamespace;

const { subjects: _RequestNested2Subjects } = MakaioBus.registerNamespace(
  createBusNamespace('requestNested2', {
    'test.create.requested': {
      request: z.object({ taskName: z.string() }),
      response: z.object({ taskId: z.string() }),
    },
  }),
);

const { subjects: _AdapterClaudeCodeSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('adapter:claudeCode', {
    'tool.use': z.object({ toolName: z.string() }),
    'stream.chunk': z.object({ content: z.string() }),
  }),
);

const _AdapterOpenAINamespace = MakaioBus.registerNamespace(
  createBusNamespace('adapter:openai', {
    'tool.call': z.object({ functionName: z.string() }),
    'stream.delta': z.object({ text: z.string() }),
  }),
);

const { subjects: _AdapterOpenAISubjects } = _AdapterOpenAINamespace;

const { subjects: _AdapterClaudeCodeSdkSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('adapter:claudeCode:sdk', {
    'stream.thinking.content': z.object({ text: z.string() }),
  }),
);

/**
 * Tests for nested subject names (subject keys containing dots).
 *
 * Examples:
 * - 'tool.use' (1 dot)
 * - 'stream.chunk.partial' (2 dots)
 * - 'agent.tool.execution.started' (3 dots)
 */
describe('Nested Subjects', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('global bus - nested subject keys', () => {
    it('registers and uses subject keys with 1 dot', async () => {
      const received: Array<{ toolName: string }> = [];

      MakaioBus.on(_Nested1Subjects.tool.use, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(_Nested1Subjects.tool.use, { toolName: 'bash' });

      expect(received).toEqual([{ toolName: 'bash' }]);
      expect(_Nested1Subjects.tool.use.$meta.namespace).toBe('nested1');
      expect(_Nested1Subjects.tool.use.subject).toBe('tool.use');
    });

    it('registers and uses subject keys with 2 dots', async () => {
      const received: Array<{ content: string }> = [];

      MakaioBus.on(_Nested2Subjects.stream.chunk.partial, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(_Nested2Subjects.stream.chunk.partial, {
        content: 'hello',
      });

      expect(received).toEqual([{ content: 'hello' }]);
      expect(_Nested2Subjects.stream.chunk.partial.$meta.namespace).toBe('nested2');
      expect(_Nested2Subjects.stream.chunk.partial.subject).toBe('stream.chunk.partial');
    });

    it('registers and uses subject keys with 3 dots', async () => {
      const received: Array<{ toolName: string }> = [];

      MakaioBus.on(_Nested3Subjects.agent.tool.execution.started, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(_Nested3Subjects.agent.tool.execution.started, {
        toolName: 'bash',
      });

      expect(received).toEqual([{ toolName: 'bash' }]);
      expect(_Nested3Subjects.agent.tool.execution.started.$meta.namespace).toBe('nested3');
      expect(_Nested3Subjects.agent.tool.execution.started.subject).toBe('agent.tool.execution.started');
    });

    it('verifies handler parameter types are correctly inferred', async () => {
      // Test that payload types are inferred correctly by using them in type-sensitive ways
      MakaioBus.on(_Nested1Subjects.tool.use, ({ payload }) => {
        // If payload.toolName wasn't typed as string, these operations would fail
        const upperName: string = payload.toolName.toUpperCase();
        expect(upperName).toBe('BASH');
      });

      await MakaioBus.emit(_Nested1Subjects.tool.use, { toolName: 'bash' });
    });
  });

  describe('scoped bus - nested subject keys', () => {
    it('emits and receives subject keys with 1 dot', async () => {
      const scopedBus = MakaioBus.scoped(_ScopedNamespace);
      const received: Array<{ toolName: string }> = [];

      scopedBus.on(_ScopedSubjects.tool.use, ({ payload }) => {
        received.push(payload);
      });

      await scopedBus.emit(_ScopedSubjects.tool.use, { toolName: 'bash' });

      expect(received).toEqual([{ toolName: 'bash' }]);
    });

    it('emits and receives subject keys with 2 dots', async () => {
      const scopedBus = MakaioBus.scoped(_ScopedNamespace);
      const received: Array<{ content: string }> = [];

      scopedBus.on(_ScopedSubjects.stream.chunk.partial, ({ payload }) => {
        received.push(payload);
      });

      await scopedBus.emit(_ScopedSubjects.stream.chunk.partial, { content: 'hello' });

      expect(received).toEqual([{ content: 'hello' }]);
    });

    it('works with both global and scoped subscriptions', async () => {
      const scopedBus = MakaioBus.scoped(_ScopedNamespace);
      const scopedReceived: Array<{ toolName: string }> = [];
      const globalReceived: Array<{ toolName: string }> = [];

      // Subscribe via scoped bus
      scopedBus.on(_ScopedSubjects.tool.use, ({ payload }) => {
        scopedReceived.push(payload);
      });

      // Subscribe via global bus
      MakaioBus.on(_ScopedSubjects.tool.use, ({ payload }) => {
        globalReceived.push(payload);
      });

      // Emit via scoped bus
      await scopedBus.emit(_ScopedSubjects.tool.use, { toolName: 'bash' });

      // Both should receive
      expect(scopedReceived).toEqual([{ toolName: 'bash' }]);
      expect(globalReceived).toEqual([{ toolName: 'bash' }]);
    });

    it('verifies scoped handler parameter types are correctly inferred', async () => {
      const scopedBus = MakaioBus.scoped(_ScopedNamespace);

      scopedBus.on(_ScopedSubjects.tool.use, ({ payload }) => {
        // If payload.toolName wasn't typed as string, these operations would fail
        const length: number = payload.toolName.length;
        expect(length).toBe(4);
      });

      await scopedBus.emit(_ScopedSubjects.tool.use, { toolName: 'bash' });
    });
  });

  describe('request/response with nested subject keys', () => {
    it('handles requests with nested subject keys in global bus', async () => {
      MakaioBus.on(_RequestNestedSubjects.tool.execute, (context) => {
        if (context.isRequest) {
          context.setResult({ result: `executed ${context.payload.toolName}` });
        }
      });

      const result = await MakaioBus.request(_RequestNestedSubjects.tool.execute, {
        toolName: 'bash',
      });

      expect(result).toEqual({ result: 'executed bash' });
    });

    it('handles requests with nested subject keys in scoped bus', async () => {
      const scopedBus = MakaioBus.scoped(_ScopedRequestNamespace);

      /**
       * KNOWN LIMITATION: ScopedBus type inference for request/response subjects is limited.
       * This is a known type system constraint documented in scoped-bus.test.ts.
       * The workaround uses a type guard and explicit type assertion until the limitation is resolved.
       */
      scopedBus.on(_ScopedRequestSubjects.tool.execute, (context: unknown) => {
        // Type guard to check if this is a request context
        if (
          typeof context === 'object' &&
          context !== null &&
          'isRequest' in context &&
          context.isRequest === true &&
          'setResult' in context &&
          'payload' in context
        ) {
          // Workaround: Cast to specific types after type guard validation
          const requestContext = context as RequestContext<{ toolName: string }, { result: string }>;
          requestContext.setResult({ result: `executed ${requestContext.payload.toolName}` });
        }
      });

      /**
       * KNOWN LIMITATION: The request payload type cannot be inferred for scoped bus requests.
       * Type assertions are required until the type system limitation is resolved.
       * At runtime, the payload is validated against the Zod schema, so type safety is maintained.
       */
      const result = await scopedBus.request(_ScopedRequestSubjects.tool.execute, {
        toolName: 'bash',
      } as never);

      expect(result).toEqual({ result: 'executed bash' });
    });

    it('handles requests with 2-dot nested subject keys', async () => {
      MakaioBus.on(_RequestNested2Subjects.test.create.requested, (context) => {
        if (context.isRequest) {
          context.setResult({ taskId: `task-${context.payload.taskName}` });
        }
      });

      const result = await MakaioBus.request(_RequestNested2Subjects.test.create.requested, {
        taskName: 'test',
      });

      expect(result).toEqual({ taskId: 'task-test' });
    });
  });

  describe('hierarchical namespaces + nested subject keys', () => {
    it('combines colon-based namespace hierarchy with dot-based subject nesting', async () => {
      // Namespace: adapter:claudeCode (2 levels with colon)
      // Subject key: tool.use (1 level with dot)
      // Full subject: adapter:claudeCode.tool.use
      const received: Array<{ toolName: string }> = [];

      MakaioBus.on(_AdapterClaudeCodeSubjects.tool.use, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(_AdapterClaudeCodeSubjects.tool.use, { toolName: 'bash' });

      expect(received).toEqual([{ toolName: 'bash' }]);
      expect(_AdapterClaudeCodeSubjects.tool.use.$meta.namespace).toBe('adapter:claudeCode');
      expect(_AdapterClaudeCodeSubjects.tool.use.subject).toBe('tool.use');
    });

    it('works in scoped bus with hierarchical namespace and nested subjects', async () => {
      const scopedBus = MakaioBus.scoped(_AdapterOpenAINamespace);
      const received: Array<{ functionName: string }> = [];

      scopedBus.on(_AdapterOpenAISubjects.tool.call, ({ payload }) => {
        received.push(payload);
      });

      await scopedBus.emit(_AdapterOpenAISubjects.tool.call, { functionName: 'get_weather' });

      expect(received).toEqual([{ functionName: 'get_weather' }]);
    });

    it('handles 3-level namespace + 2-level subject nesting', async () => {
      // Namespace: adapter:claudeCode:sdk (3 levels with colons)
      // Subject key: stream.thinking.content (2 levels with dots)
      // Full subject: adapter:claudeCode:sdk.stream.thinking.content
      const received: Array<{ text: string }> = [];

      MakaioBus.on(_AdapterClaudeCodeSdkSubjects.stream.thinking.content, ({ payload }) => {
        received.push(payload);
      });

      await MakaioBus.emit(_AdapterClaudeCodeSdkSubjects.stream.thinking.content, {
        text: 'analyzing...',
      });

      expect(received).toEqual([{ text: 'analyzing...' }]);
      expect(_AdapterClaudeCodeSdkSubjects.stream.thinking.content.$meta.namespace).toBe('adapter:claudeCode:sdk');
      expect(_AdapterClaudeCodeSdkSubjects.stream.thinking.content.subject).toBe('stream.thinking.content');
    });

    it('verifies hierarchical namespace handler types are correctly inferred', async () => {
      const scopedBus = MakaioBus.scoped(_AdapterOpenAINamespace);

      scopedBus.on(_AdapterOpenAISubjects.tool.call, ({ payload }) => {
        // If payload.functionName wasn't typed as string, this would fail
        const hasPrefix: boolean = payload.functionName.startsWith('get_');
        expect(hasPrefix).toBe(true);
      });

      await scopedBus.emit(_AdapterOpenAISubjects.tool.call, { functionName: 'get_weather' });
    });
  });

  describe('type safety - negative tests', () => {
    /**
     * Assert that an async operation throws a Zod validation error.
     *
     * TypeScript doesn't always catch payload structure errors at compile-time
     * (due to structural typing), but Zod validation at runtime will catch them.
     * @param fn - Async function expected to throw
     * @param label - Description for the failure message
     */
    async function expectValidationError(fn: () => Promise<unknown>, label: string): Promise<void> {
      let caught: unknown;
      try {
        await fn();
      } catch (error) {
        caught = error;
      }

      if (!caught) {
        expect.fail(`Should have thrown validation error: ${label}`);
      }

      // The bus wraps ZodError in ValidationError (see errors/validation-error.ts).
      // Assert the wrapper type, then verify it carries the original ZodError.
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as ValidationError).zodError).toBeInstanceOf(z.ZodError);
    }

    it('verifies runtime validation catches wrong payload shape on global bus', async () => {
      await expectValidationError(
        () => MakaioBus.emit(_Nested1Subjects.tool.use, { wrongField: 'value' } as never),
        'missing field',
      );
      await expectValidationError(
        () => MakaioBus.emit(_Nested1Subjects.tool.use, { toolName: 123 } as never),
        'wrong type',
      );
    });

    it('verifies runtime validation catches wrong request payload on global bus', async () => {
      MakaioBus.on(_RequestNestedSubjects.tool.execute, (context) => {
        if (context.isRequest) {
          context.setResult({ result: 'test' });
        }
      });

      await expectValidationError(
        () => MakaioBus.request(_RequestNestedSubjects.tool.execute, { wrongField: 'value' } as never),
        'missing field',
      );
      await expectValidationError(
        () => MakaioBus.request(_RequestNestedSubjects.tool.execute, { toolName: 456 } as never),
        'wrong type',
      );
    });

    it('prevents using non-existent subject keys on global bus', () => {
      // @ts-expect-error - 'nonExistent' is not a valid subject key in this namespace
      const invalid = _Nested1Subjects.nonExistent;
      expect(invalid).toBeUndefined();
    });

    it('documents request handler response type validation limitation', () => {
      /**
       * NOTE: Response types in request handlers are validated at runtime via Zod.
       * TypeScript doesn't catch wrong response types at compile-time in all cases.
       * This is a known limitation when using context guards.
       */
      MakaioBus.on(_RequestNestedSubjects.tool.execute, (context) => {
        if (context.isRequest) {
          // This would fail at runtime due to Zod validation
          // but TypeScript doesn't catch it at compile-time
          try {
            context.setResult({ wrongField: 'value' } as never);
          } catch (error) {
            expect(error).toBeDefined();
          }
        }
      });
    });
  });
});
