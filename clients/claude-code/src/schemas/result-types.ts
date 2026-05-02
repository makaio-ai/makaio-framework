import { z } from 'zod';
import { BetaUsageSchema } from './common/usage.js';

/**
 * Non-nullable version of BetaUsage
 * All fields from BetaUsage are required (non-null)
 * @see NonNullableUsage from \@anthropic-ai/claude-agent-sdk/sdk.d.ts
 */
export const NonNullableUsageSchema = BetaUsageSchema.extend({
  cache_creation: BetaUsageSchema.shape.cache_creation.unwrap(),
  cache_creation_input_tokens: z.number(),
  cache_read_input_tokens: z.number(),
  server_tool_use: BetaUsageSchema.shape.server_tool_use.unwrap(),
  service_tier: z.enum(['standard', 'priority', 'batch']),
});

export type NonNullableUsage = z.infer<typeof NonNullableUsageSchema>;

/**
 * Model-specific usage statistics
 * Tracks tokens per model with additional metadata
 * @see ModelUsage from \@anthropic-ai/claude-agent-sdk/sdk.d.ts
 */
export const ModelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  webSearchRequests: z.number(),
  costUSD: z.number(),
  contextWindow: z.number(),
});

export type ModelUsage = z.infer<typeof ModelUsageSchema>;

/**
 * Permission denial record
 * Tracks when a tool usage was denied with full context
 * @see SDKPermissionDenial from \@anthropic-ai/claude-agent-sdk/sdk.d.ts
 */
export const PermissionDenialSchema = z.object({
  tool_name: z.string(),
  tool_use_id: z.string(),
  tool_input: z.unknown(),
});

export type PermissionDenial = z.infer<typeof PermissionDenialSchema>;
