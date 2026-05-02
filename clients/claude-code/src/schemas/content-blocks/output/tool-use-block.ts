import { z } from 'zod';

/**
 * Tool use content block
 * @see BetaToolUseBlock from \@anthropic-ai/sdk
 */
export const BetaToolUseBlockSchema = z.object({
  id: z.string(),
  input: z.looseObject({}),
  name: z.string(),
  type: z.literal('tool_use'),
});

export type BetaToolUseBlock = z.infer<typeof BetaToolUseBlockSchema>;
