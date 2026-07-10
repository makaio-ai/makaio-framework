/**
 * Terminal-result usage normalization for Claude protocol adapters.
 *
 * The Claude SDK reports usage once per query on the terminal `result`
 * message. These pure helpers translate that raw usage block into the
 * framework's normalized usage contract and into context-window occupancy,
 * keeping the agent class free of provider-specific accounting math.
 * @packageDocumentation
 */

import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';

/**
 * Raw usage block carried on a Claude terminal `result` message.
 *
 * Mirrors the SDK's `NonNullableUsage` fields consumed by the agent layer;
 * cache fields stay optional because lenient bus validation may deliver
 * drifted payloads that omit them.
 */
export type TerminalResultUsage = {
  /** Uncached input tokens billed for the query. */
  input_tokens: number;
  /** Input tokens read from the prompt cache. */
  cache_read_input_tokens?: number;
  /** Input tokens written to the prompt cache. */
  cache_creation_input_tokens?: number;
  /** Output tokens produced across the query. */
  output_tokens: number;
  /** Provider service tier the query was billed under. */
  service_tier?: string;
};

/**
 * Normalize a Claude terminal-result usage block into the framework contract.
 *
 * The terminal result aggregates one query — potentially multiple model turns
 * in agentic tool loops — hence `granularity: 'query-aggregate'`. When present,
 * cost is the provider's own `total_cost_usd`, hence
 * `costProvenance: 'provider-reported'`.
 * @param usage - Raw usage block from the terminal result message
 * @param totalCostUsd - Provider-reported cost for the whole query, in USD
 * @returns Normalized usage ready for `AIAgent.trackUsage()`
 */
export function normalizeTerminalResultUsage(
  usage: TerminalResultUsage,
  totalCostUsd: number | undefined,
): NormalizedCallUsage {
  return {
    provider: 'anthropic',
    granularity: 'query-aggregate',
    inputTokens: usage.input_tokens,
    inputCachedTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: 0,
    totalTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens,
    costUnits: 1,
    costUnitType: 'requests',
    ...(totalCostUsd === undefined
      ? {}
      : {
          cost: totalCostUsd,
          costProvenance: 'provider-reported' as const,
        }),
    serviceTier: usage.service_tier,
  };
}

/**
 * Compute the context-window occupancy implied by a terminal usage block.
 *
 * Unlike billing totals, occupancy counts cache writes too: every input
 * token — cached, freshly written, or uncached — plus the produced output
 * resides in the context window.
 * @param usage - Raw usage block from the terminal result message
 * @returns Total tokens currently occupying the context window
 */
export function computeContextWindowTokens(usage: TerminalResultUsage): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  );
}
