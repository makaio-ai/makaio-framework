/**
 * Gemini usage normalization.
 *
 * Pure mapping from the Gemini SDK's `session.finished` usage metadata to the
 * shared `NormalizedCallUsage` format, kept separate from the agent wiring so
 * it is independently testable.
 * @packageDocumentation
 */

import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';

/**
 * Usage metadata as reported by the Gemini SDK on `session.finished`.
 */
export interface GeminiUsageMetadata {
  /** Prompt (input) token count. */
  promptTokenCount?: number;
  /** Cached prompt tokens reused from context caching. */
  cachedContentTokenCount?: number;
  /** Candidate (output) token count. */
  candidatesTokenCount?: number;
  /** Thinking/reasoning token count. */
  thoughtsTokenCount?: number;
  /** Total token count across all categories. */
  totalTokenCount?: number;
  /** Billing traffic type (e.g. provisioned throughput). */
  trafficType?: string;
}

/**
 * Normalize Gemini `session.finished` usage metadata to `NormalizedCallUsage`.
 *
 * Granularity is `turn-aggregate`: the SDK reports usage once per finished
 * session turn, which may fold several internal model calls (e.g. tool-loop
 * iterations) into a single measurement.
 * @param usageMetadata - Usage metadata from the `session.finished` event
 * @returns Normalized usage metrics ready for `trackUsage()`
 */
export function normalizeGeminiUsage(usageMetadata?: GeminiUsageMetadata): NormalizedCallUsage {
  return {
    granularity: 'turn-aggregate',
    provider: 'gemini',
    inputTokens: usageMetadata?.promptTokenCount ?? 0,
    inputCachedTokens: usageMetadata?.cachedContentTokenCount ?? 0,
    outputTokens: usageMetadata?.candidatesTokenCount ?? 0,
    reasoningTokens: usageMetadata?.thoughtsTokenCount ?? 0,
    totalTokens: usageMetadata?.totalTokenCount ?? 0,
    costUnits: 1,
    costUnitType: 'requests',
    serviceTier: usageMetadata?.trafficType,
  };
}
