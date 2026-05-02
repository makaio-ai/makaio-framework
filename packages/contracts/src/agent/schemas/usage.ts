import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Per-call token usage metrics.
 *
 * Subject: `agent.usage`
 * Type: Event (fire-and-forget)
 * Emitted when: Usage metrics are available from an AI provider API call
 *
 * This event contains delta metrics for a single API call.
 * For session-level cumulative totals, see `agent.session.usage`.
 */
export const UsageSchema = BaseAgentEventSchema.extend({
  provider: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  inputCachedTokens: z.number(),
  cacheWriteTokens: z.number().optional(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  costUnits: z.number(),
  costUnitType: z.enum(['requests', 'tokens']),
  cost: z.number().optional(),
  currency: z.string().optional(),
  audioInputTokens: z.number().optional(),
  audioOutputTokens: z.number().optional(),
  /** Billing tier (e.g., 'standard', 'PROVISIONED_THROUGHPUT') */
  serviceTier: z.string().optional(),
  /** API call latency in milliseconds */
  duration: z.number().optional(),
  /** Model context window size in tokens */
  contextWindow: z.number().optional(),
  quota: z
    .object({
      type: z.string(),
      limit: z.number(),
      used: z.number(),
      overage: z.number(),
      resetDate: z.string().optional(),
    })
    .optional(),
});

export type Usage = z.infer<typeof UsageSchema>;
