import { z } from 'zod';

/**
 * Base schema for a reasoning delta event.
 *
 * Emitted during streaming when the model outputs incremental reasoning /
 * thinking content. Both Anthropic (extended thinking) and OpenAI-compatible
 * reasoning models emit this event.
 *
 * Adapter-specific schemas may extend this via `.extend()`.
 */
export const ReasoningDeltaEventSchema = z.object({
  eventType: z.literal('reasoning_delta'),
  /** Reasoning content delta from this streaming chunk. */
  content: z.string(),
});

/** Inferred reasoning delta event type. */
export type ReasoningDeltaEvent = z.infer<typeof ReasoningDeltaEventSchema>;

/**
 * Base schema for a reasoning complete event.
 *
 * Emitted when the full reasoning / thinking content has been assembled from
 * all streaming deltas. Does NOT include the Anthropic-specific `signature`
 * field — the Anthropic adapter extends this schema with `.extend()`.
 *
 * Adapter-specific schemas may extend this via `.extend()`.
 */
export const ReasoningCompleteEventSchema = z.object({
  eventType: z.literal('reasoning_complete'),
  /** Complete assembled reasoning content. */
  content: z.string(),
});

/** Inferred reasoning complete event type. */
export type ReasoningCompleteEvent = z.infer<typeof ReasoningCompleteEventSchema>;
