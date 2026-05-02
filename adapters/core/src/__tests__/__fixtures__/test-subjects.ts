import { z } from 'zod';
import { createAdapterNamespace } from '@makaio/ai-adapters-core';

/**
 * Test adapter namespace with diverse subject types.
 *
 * Includes:
 * - Simple event: `thinking` with `{ content: string }`
 * - Nested event: `tool.use` with `{ toolId: string, args?: unknown }`
 * - Request/response pair: `getContext` with sessionId request and context response
 *
 * Used for testing adapter integration with the bus system.
 * @example
 * ```typescript
 * import { TestAdapterNamespace, TestSubjects } from './test-subjects';
 *
 * // Use namespace for scoped bus creation
 * const bus = await TestAdapterNamespace.scopedBus();
 *
 * // Use individual subjects for type-safe emit/on
 * bus.emit(TestSubjects.thinking, { content: 'processing...' });
 * bus.on(TestSubjects.toolUse, ({ payload }) => {
 *   console.debug('Tool:', payload.toolId);
 * });
 *
 * const result = await bus.request(TestSubjects.getContext, { sessionId: 'abc' });
 * console.debug('Context:', result.context);
 * ```
 */
export const TestAdapterNamespace = createAdapterNamespace('adapter:test', {
  /**
   * Simple event: Thinking/reasoning content.
   *
   * Subject: `adapter:test.thinking`
   * Type: Event (fire-and-forget)
   */
  thinking: z.object({
    content: z.string(),
  }),

  /**
   * Nested event: Tool usage notification.
   *
   * Subject: `adapter:test.tool.use`
   * Type: Event (fire-and-forget)
   */
  'tool.use': z.object({
    toolId: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),

  /**
   * Generic event for testing global-to-local proxying.
   *
   * Subject: `adapter:test.event`
   * Type: Event (fire-and-forget)
   */
  event: z.object({
    eventType: z.string(),
    data: z.record(z.string(), z.unknown()).optional(),
  }),

  /**
   * Pause event for testing flow control.
   *
   * Subject: `adapter:test.pause`
   * Type: Event (fire-and-forget)
   */
  pause: z.object({
    reason: z.string().optional(),
  }),

  /**
   * Resume event for testing flow control.
   *
   * Subject: `adapter:test.resume`
   * Type: Event (fire-and-forget)
   */
  resume: z.object({
    fromState: z.string().optional(),
  }),

  /**
   * Request/response: Get session context.
   *
   * Subject: `adapter:test.getContext`
   * Type: Request (RPC)
   */
  getContext: {
    request: z.object({
      sessionId: z.string(),
    }),
    response: z.object({
      context: z.string(),
    }),
  },

  /**
   * Request/response: Query adapter data.
   *
   * Subject: `adapter:test.query`
   * Type: Request (RPC)
   */
  query: {
    request: z.object({
      query: z.string(),
    }),
    response: z.object({
      results: z.array(z.record(z.string(), z.unknown())),
    }),
  },
});

/**
 * Individual subject references for convenient importing.
 * @example
 * ```typescript
 * import { TestSubjects } from './test-subjects';
 *
 * bus.emit(TestSubjects.thinking, { content: 'hello' });
 * ```
 */
export const TestSubjects = TestAdapterNamespace.subjects;
