import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';

/**
 * Tool use content block parameter
 * @see BetaToolUseBlockParam from \@anthropic-ai/sdk
 */
export const BetaToolUseBlockParamSchema = z.object({
  id: z.string(),
  input: z.record(z.string(), z.unknown()),
  name: z.string(),
  type: z.literal('tool_use'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
});

export type BetaToolUseBlockParam = z.infer<typeof BetaToolUseBlockParamSchema>;
