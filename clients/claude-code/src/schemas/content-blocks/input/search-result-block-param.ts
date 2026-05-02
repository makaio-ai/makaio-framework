import { z } from 'zod';
import { BetaCacheControlEphemeralSchema, BetaCitationsConfigParamSchema } from '../../common/index.js';
import { BetaTextBlockParamSchema } from './text-block-param.js';

/**
 * Search result content block parameter
 * @see BetaSearchResultBlockParam from \@anthropic-ai/sdk
 */
export const BetaSearchResultBlockParamSchema = z.object({
  content: z.array(BetaTextBlockParamSchema),
  source: z.string(),
  title: z.string(),
  type: z.literal('search_result'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
  citations: BetaCitationsConfigParamSchema.optional(),
});

export type BetaSearchResultBlockParam = z.infer<typeof BetaSearchResultBlockParamSchema>;
