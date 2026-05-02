import { z } from 'zod';

/**
 * Schema for reasoning.delta event
 * Emitted for incremental reasoning content
 */
export const ReasoningDeltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  delta: z.string(),
  timestamp: z.number(),
});

/**
 * Schema for reasoning event
 * Emitted when complete reasoning is available
 */
export const ReasoningSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  reasoning: z.string(),
  timestamp: z.number(),
});

// Export inferred types
export type ReasoningDelta = z.infer<typeof ReasoningDeltaSchema>;
export type Reasoning = z.infer<typeof ReasoningSchema>;
