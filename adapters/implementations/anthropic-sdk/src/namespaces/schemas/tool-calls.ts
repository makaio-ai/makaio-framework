import { z } from 'zod';

import { ToolCallSchema as BaseToolCallSchema } from '@makaio/ai-adapters-stream-session';

/**
 * Schema for a single tool call.
 * Normalized from Anthropic ToolUseBlock structure.
 * Extends the base schema with `blockIndex` for stable cross-event ordering.
 */
const ToolCallSchema = BaseToolCallSchema.extend({
  /** Original Anthropic content block index (for stable cross-event ordering). */
  blockIndex: z.number().int().nonnegative(),
});

/**
 * Schema for tool calls event.
 * Emitted when the model requests tool/function execution.
 */
export const ToolCallsEventSchema = z.object({
  eventType: z.literal('tool_calls'),
  /** Array of tool calls requested by the model */
  toolCalls: z.array(ToolCallSchema),
});

export type ToolCallsEvent = z.infer<typeof ToolCallsEventSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
