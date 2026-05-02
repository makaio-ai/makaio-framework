import { z } from 'zod';

/**
 * Redacted thinking content block parameter
 * @see BetaRedactedThinkingBlockParam from \@anthropic-ai/sdk
 */
export const BetaRedactedThinkingBlockParamSchema = z.object({
  data: z.string(),
  type: z.literal('redacted_thinking'),
});

export type BetaRedactedThinkingBlockParam = z.infer<typeof BetaRedactedThinkingBlockParamSchema>;
