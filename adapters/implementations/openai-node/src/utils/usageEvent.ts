import type { UsageEvent } from '../namespaces/index.js';

/** Extracted token usage with optional detail breakdowns. */
export interface ExtractedUsage {
  promptTokens: number;
  completionTokens: number;
  promptTokensDetails?: { audio_tokens?: number; cached_tokens?: number };
  completionTokensDetails?: {
    accepted_prediction_tokens?: number;
    audio_tokens?: number;
    reasoning_tokens?: number;
    rejected_prediction_tokens?: number;
  };
}

/**
 * Build the normalized usage event payload.
 * @param usage - Token usage extracted from the streaming chunk
 * @returns SDK usage event payload
 */
export function buildUsageEventPayload(usage: ExtractedUsage): UsageEvent {
  const payload: UsageEvent = {
    eventType: 'usage',
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  };
  if (usage.promptTokensDetails) payload.prompt_tokens_details = usage.promptTokensDetails;
  if (usage.completionTokensDetails) payload.completion_tokens_details = usage.completionTokensDetails;
  return payload;
}
