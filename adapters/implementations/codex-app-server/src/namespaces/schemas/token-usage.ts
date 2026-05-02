import { z } from 'zod';

/**
 * Schema for token_usage event
 * Emitted when token usage is updated.
 *
 * Note: agentId is required for bus filtering to work correctly.
 */
export const TokenUsageSchema = z.object({
  agentId: z.string(),
  threadId: z.string(),
  turnId: z.string().optional(),
  promptTokens: z.number(),
  inputCachedTokens: z.number().default(0),
  completionTokens: z.number(),
  reasoningTokens: z.number().default(0),
  totalTokens: z.number(),
  modelContextWindow: z.number().optional(),
  timestamp: z.number(),
});

// Export inferred types
export type TokenUsageEvent = z.infer<typeof TokenUsageSchema>;
