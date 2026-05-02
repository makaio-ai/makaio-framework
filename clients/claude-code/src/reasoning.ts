import type { ReasoningLevelMap } from '@makaio/contracts';

/**
 * Claude reasoning level mapping shared by Anthropic-compatible Claude providers.
 *
 * Maps named reasoning levels to their corresponding max-tokens budgets.
 * A value of `0` disables extended thinking for that level.
 */
export const claudeReasoningLevels: ReasoningLevelMap = {
  none: 0,
  low: 4000,
  medium: 8000,
  high: 16000,
  'extra-high': 32000,
};
