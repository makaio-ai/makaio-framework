import { z } from 'zod';

/**
 * Schema for token usage event.
 * Based on Anthropic Usage structure.
 * @see https://docs.anthropic.com/en/api/messages
 */
export const UsageEventSchema = z.object({
  eventType: z.literal('usage'),
  /** Runtime-generated identifier for this concrete provider request. */
  llmCallId: z.string().optional(),
  /** Workflow execution that caused the request, when known. */
  executionId: z.string().optional(),
  /** Workflow frame/station that caused the request, when known. */
  frameId: z.string().optional(),
  /** Number of tokens in the prompt (input) */
  prompt_tokens: z.number(),
  /** Number of tokens in the generated completion (output) */
  completion_tokens: z.number(),
  /** Total tokens used (prompt + completion) */
  total_tokens: z.number(),
  /** Number of tokens read from cache */
  cache_read_input_tokens: z.number().optional(),
  /** Number of tokens written to cache */
  cache_creation_input_tokens: z.number().optional(),
});

export type UsageEvent = z.infer<typeof UsageEventSchema>;
