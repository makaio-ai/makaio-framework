import type { AIReasoningLevel } from '@makaio/contracts';

/**
 * Copilot SDK reasoning effort string values.
 * Mirrors the SDK's internal `ReasoningEffort` type, which is not re-exported
 * from the public package index (`@github/copilot-sdk`).
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * Map canonical {@link AIReasoningLevel} to the Copilot SDK's {@link ReasoningEffort}.
 *
 * Returns `undefined` for `'none'` so the caller can omit `reasoningEffort`
 * from the session config entirely (SDK default behavior when omitted).
 * @param level - Canonical reasoning level
 * @returns SDK-native effort string, or `undefined` when reasoning should be omitted
 */
export function toSdkReasoningEffort(level: AIReasoningLevel): ReasoningEffort | undefined {
  switch (level) {
    case 'none':
      return undefined;
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'extra-high':
      return 'xhigh';
    default: {
      // Exhaustiveness guard: new AIReasoningLevel values must be mapped here.
      const _exhaustive: never = level;
      throw new Error(`Unhandled AIReasoningLevel: ${String(_exhaustive)}`);
    }
  }
}
