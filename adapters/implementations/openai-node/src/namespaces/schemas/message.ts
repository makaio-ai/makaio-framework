import { z } from 'zod';

import { MessageCompleteEventSchema as BaseMessageCompleteEventSchema } from '@makaio/ai-adapters-stream-session';

/**
 * Schema for message complete event.
 * Emitted when a full assistant message has been assembled from streaming chunks.
 * Extends the base schema with OpenAI-specific `finish_reason` values.
 */
export const MessageCompleteEventSchema = BaseMessageCompleteEventSchema.extend({
  /** Why generation stopped (OpenAI-specific values). */
  finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']).nullable(),
});

export type MessageCompleteEvent = z.infer<typeof MessageCompleteEventSchema>;
