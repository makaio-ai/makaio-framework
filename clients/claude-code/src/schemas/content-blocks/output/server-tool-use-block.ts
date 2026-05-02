import { z } from 'zod';

/**
 * Server tool use content block
 * @see BetaServerToolUseBlock from \@anthropic-ai/sdk
 */
export const BetaServerToolUseBlockSchema = z.object({
  id: z.string(),
  input: z.looseObject({}),
  name: z.enum(['web_search', 'code_execution']),
  type: z.literal('server_tool_use'),
});

export type BetaServerToolUseBlock = z.infer<typeof BetaServerToolUseBlockSchema>;
