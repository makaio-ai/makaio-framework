import type { AIReasoningLevel } from '@makaio/ai-adapters-core';
import { claudeReasoningLevels } from '@makaio/client-claude-code';

/**
 * Maps a normalized reasoning level to provider max thinking tokens.
 * @param level - Reasoning level requested by caller
 * @returns Token budget to pass to the SDK
 */
export function parseReasoningLevel(level: AIReasoningLevel): number {
  const value = claudeReasoningLevels[level];
  return typeof value === 'number' ? value : 0;
}
