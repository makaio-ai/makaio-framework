import { z } from 'zod';

import {
  ReasoningDeltaEventSchema as BaseReasoningDeltaEventSchema,
  ReasoningCompleteEventSchema as BaseReasoningCompleteEventSchema,
} from '@makaio/ai-adapters-stream-session';

/**
 * Schema for reasoning delta event.
 * Emitted during streaming when the model outputs extended thinking content.
 * Supported by Anthropic models with extended thinking enabled.
 */
export const ReasoningDeltaEventSchema = BaseReasoningDeltaEventSchema;

/**
 * Schema for reasoning complete event.
 * Emitted when full reasoning/thinking content has been assembled.
 * Extends the base schema with the Anthropic-specific `signature` field.
 */
export const ReasoningCompleteEventSchema = BaseReasoningCompleteEventSchema.extend({
  /**
   * Optional Anthropic thinking signature assembled from `signature_delta`.
   * Persisted as reasoning block metadata for native history round-trip.
   */
  signature: z.string().optional(),
});

export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;
export type ReasoningCompleteEvent = z.infer<typeof ReasoningCompleteEventSchema>;
