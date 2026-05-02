import { z } from 'zod';

/**
 * Server tool usage tracking
 * @see BetaServerToolUsage from \@anthropic-ai/sdk
 */
export const BetaServerToolUsageSchema = z.object({
  /**
   * The number of web search tool requests.
   */
  web_search_requests: z.number(),
});

/**
 * Breakdown of cached tokens by TTL
 * @see BetaCacheCreation from \@anthropic-ai/sdk
 */
export const BetaCacheCreationSchema = z.object({
  /**
   * The number of input tokens used to create the 1 hour cache entry.
   */
  ephemeral_1h_input_tokens: z.number(),
  /**
   * The number of input tokens used to create the 5 minute cache entry.
   */
  ephemeral_5m_input_tokens: z.number(),
});

/**
 * Billing and rate-limit usage
 * @see BetaUsage from \@anthropic-ai/sdk
 */
export const BetaUsageSchema = z.object({
  /**
   * Breakdown of cached tokens by TTL
   */
  cache_creation: BetaCacheCreationSchema.nullable().optional(),
  /**
   * The number of input tokens used to create the cache entry.
   */
  cache_creation_input_tokens: z.number().nullable().optional(),
  /**
   * The number of input tokens read from the cache.
   */
  cache_read_input_tokens: z.number().nullable().optional(),
  /**
   * The number of input tokens which were used.
   */
  input_tokens: z.number(),
  /**
   * The number of output tokens which were used.
   */
  output_tokens: z.number(),
  /**
   * The number of server tool requests.
   */
  server_tool_use: BetaServerToolUsageSchema.nullable().optional(),
  /**
   * If the request used the priority, standard, or batch tier.
   */
  service_tier: z.enum(['standard', 'priority', 'batch']).nullable().optional(),
});

/**
 * Delta usage tracking for message updates
 * @see BetaMessageDeltaUsage from \@anthropic-ai/sdk
 */
export const BetaMessageDeltaUsageSchema = z.object({
  /**
   * The cumulative number of input tokens used to create the cache entry.
   */
  cache_creation_input_tokens: z.number().nullable().optional(),
  /**
   * The cumulative number of input tokens read from the cache.
   */
  cache_read_input_tokens: z.number().nullable().optional(),
  /**
   * The cumulative number of input tokens which were used.
   */
  input_tokens: z.number().nullable().optional(),
  /**
   * The cumulative number of output tokens which were used.
   */
  output_tokens: z.number(),
  /**
   * The number of server tool requests.
   */
  server_tool_use: BetaServerToolUsageSchema.nullable().optional(),
});

export type BetaServerToolUsage = z.infer<typeof BetaServerToolUsageSchema>;
export type BetaCacheCreation = z.infer<typeof BetaCacheCreationSchema>;
export type BetaUsage = z.infer<typeof BetaUsageSchema>;
export type BetaMessageDeltaUsage = z.infer<typeof BetaMessageDeltaUsageSchema>;
