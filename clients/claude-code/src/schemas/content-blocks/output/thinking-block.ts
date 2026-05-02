import { z } from 'zod';

/**
 * Thinking content block
 * @see BetaThinkingBlock from \@anthropic-ai/sdk
 */
export const BetaThinkingBlockSchema = z.object({
  signature: z.string(),
  thinking: z.string(),
  type: z.literal('thinking'),
});

export type BetaThinkingBlock = z.infer<typeof BetaThinkingBlockSchema>;
