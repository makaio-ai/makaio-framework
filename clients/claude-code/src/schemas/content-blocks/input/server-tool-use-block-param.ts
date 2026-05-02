import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';

/**
 * Server tool use content block parameter
 * @see BetaServerToolUseBlockParam from \@anthropic-ai/sdk
 */
export const BetaServerToolUseBlockParamSchema = z.object({
  id: z.string(),
  input: z.record(z.string(), z.unknown()),
  name: z.enum(['web_search', 'code_execution']),
  type: z.literal('server_tool_use'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
});

export type BetaServerToolUseBlockParam = z.infer<typeof BetaServerToolUseBlockParamSchema>;
