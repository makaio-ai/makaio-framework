import { z } from 'zod';

import { ToolCallFunctionSchema } from './tool-calls.js';

/**
 * Base schema for a tool call embedded in a message complete event.
 *
 * Contains only the fields common to both Anthropic and OpenAI adapters.
 * The Anthropic adapter's version additionally carries `blockIndex`.
 */
export const MessageToolCallSchema = z.object({
  /** Unique identifier for this tool call. */
  id: z.string(),
  /** Type of tool (always 'function' for now). */
  type: z.literal('function'),
  /** Function call details. */
  function: ToolCallFunctionSchema,
});

/** Inferred base message tool call type. */
export type MessageToolCall = z.infer<typeof MessageToolCallSchema>;

/**
 * Base schema for a message complete event.
 *
 * Emitted when a full assistant message has been assembled from streaming
 * chunks. The `finish_reason` and `tool_calls` fields are left open for
 * each adapter to specialise via `.extend()`, since the allowed values
 * differ between providers.
 *
 * Adapter-specific schemas MUST extend this schema and narrow:
 * - `finish_reason` to their provider-specific enum
 * - `tool_calls` to their adapter-specific tool-call schema (if needed)
 */
export const MessageCompleteEventSchema = z.object({
  eventType: z.literal('message_complete'),
  /** Assembled content from all streaming deltas. */
  content: z.string().nullable(),
  /** Assembled reasoning / thinking content (if the model supports it). */
  reasoning: z.string().optional(),
  /** Tool calls requested by the model. */
  tool_calls: z.array(MessageToolCallSchema).optional(),
  /**
   * Why generation stopped.
   *
   * Kept as `z.string().nullable()` here because Anthropic and OpenAI use
   * completely different value sets. Each adapter extends this field with
   * its own `z.enum(...)`.
   */
  finish_reason: z.string().nullable(),
});

/** Inferred base message complete event type. */
export type MessageCompleteEvent = z.infer<typeof MessageCompleteEventSchema>;
