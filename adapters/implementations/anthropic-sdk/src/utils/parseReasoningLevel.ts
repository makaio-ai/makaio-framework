import type { AIReasoningLevel } from '@makaio/ai-adapters-core';

/**
 * Canonical token budget mapping for Claude extended thinking.
 *
 * Shared across all Claude models since they use the same thinking token API.
 * Also consumed by {@link provider.ts} to populate `supportedReasoningLevels`
 * on each model entry — keeping the two sources in sync automatically.
 */
export const claudeReasoningLevelMap: Record<AIReasoningLevel, number> = {
  none: 0,
  low: 4000,
  medium: 8000,
  high: 16000,
  'extra-high': 32000,
};

/**
 * Maps a Makaio reasoning level to Anthropic's thinking budget in tokens.
 * @param level - The reasoning level to map.
 * @returns Token budget for Anthropic's `thinking` parameter (0 means omit thinking entirely).
 */
export function parseReasoningLevel(level: AIReasoningLevel): number {
  return claudeReasoningLevelMap[level] ?? 0;
}
