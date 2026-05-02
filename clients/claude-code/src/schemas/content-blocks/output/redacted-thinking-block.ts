import { z } from 'zod';

/**
 * Redacted thinking content block
 * @see BetaRedactedThinkingBlock from \@anthropic-ai/sdk
 */
export const BetaRedactedThinkingBlockSchema = z.object({
  data: z.string(),
  type: z.literal('redacted_thinking'),
});

export type BetaRedactedThinkingBlock = z.infer<typeof BetaRedactedThinkingBlockSchema>;
