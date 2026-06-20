import type { MessageDeltaUsage, Usage } from '@anthropic-ai/sdk/resources/messages/messages.js';

/** Merged token usage accumulated across message_start and message_delta events. */
export interface MergedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Sum the new per-TTL `cache_creation` breakdown into a single total.
 * @param cc - CacheCreation breakdown from the Usage object
 * @returns Total cache creation input tokens across all TTL tiers
 */
function sumCacheCreation(cc: Usage['cache_creation']): number {
  if (!cc) return 0;
  return (cc.ephemeral_5m_input_tokens ?? 0) + (cc.ephemeral_1h_input_tokens ?? 0);
}

/**
 * Merge Anthropic's initial Usage object into the stream usage accumulator.
 * @param usage - Usage from the message_start event
 * @returns MergedUsage with input token counts
 */
export function mergeInitialUsage(usage: Usage): MergedUsage {
  const newCacheCreation = sumCacheCreation(usage.cache_creation);
  return {
    inputTokens: usage.input_tokens,
    outputTokens: 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationInputTokens:
      newCacheCreation > 0 ? newCacheCreation : (usage.cache_creation_input_tokens ?? undefined),
  };
}

/**
 * Merge output-token delta usage into existing stream usage.
 * @param existing - MergedUsage populated from message_start
 * @param delta - MessageDeltaUsage from the message_delta event
 * @returns Updated MergedUsage with output token counts
 */
export function mergeDeltaUsage(existing: MergedUsage, delta: MessageDeltaUsage): MergedUsage {
  return {
    ...existing,
    outputTokens: delta.output_tokens,
    // message_delta may echo 0 when no cache update is intended; keep the
    // message_start cache metrics unless the delta carries a non-zero update.
    cacheReadInputTokens: delta.cache_read_input_tokens || existing.cacheReadInputTokens,
    cacheCreationInputTokens: delta.cache_creation_input_tokens || existing.cacheCreationInputTokens,
  };
}
