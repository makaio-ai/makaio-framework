import { z } from 'zod';

import { MessageCompleteEventSchema as BaseMessageCompleteEventSchema } from '@makaio/ai-adapters-stream-session';

/**
 * Schema for tool call in message complete event.
 * Matches Anthropic ToolUseBlock structure normalized for adapter use.
 */
const MessageToolCallSchema = z.object({
  id: z.string(),
  /** Original Anthropic content block index for step reconstruction. */
  blockIndex: z.number().int().nonnegative(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});

/**
 * Schema for message complete event.
 * Emitted when a full assistant message has been assembled from streaming chunks.
 * Extends the base schema with Anthropic-specific `finish_reason` values
 * (including `pause_turn`) and the `blockIndex` field on tool calls.
 */
export const MessageCompleteEventSchema = BaseMessageCompleteEventSchema.extend({
  /** Tool calls requested by the model. */
  tool_calls: z.array(MessageToolCallSchema).optional(),
  /** Why generation stopped (Anthropic-specific values). */
  finish_reason: z.enum(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn']).nullable(),
});

export type MessageCompleteEvent = z.infer<typeof MessageCompleteEventSchema>;
