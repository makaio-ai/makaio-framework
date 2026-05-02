import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';
import { BetaTextBlockParamSchema } from './text-block-param.js';
import { BetaImageBlockParamSchema } from './image-block-param.js';
import { BetaSearchResultBlockParamSchema } from './search-result-block-param.js';

/**
 * Tool result content block parameter
 * @see BetaToolResultBlockParam from \@anthropic-ai/sdk
 */
export const BetaToolResultBlockParamSchema = z.object({
  tool_use_id: z.string(),
  type: z.literal('tool_result'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
  content: z
    .union([
      z.string(),
      z.array(z.union([BetaTextBlockParamSchema, BetaImageBlockParamSchema, BetaSearchResultBlockParamSchema])),
    ])
    .optional(),
  is_error: z.boolean().optional(),
});

export type BetaToolResultBlockParam = z.infer<typeof BetaToolResultBlockParamSchema>;
