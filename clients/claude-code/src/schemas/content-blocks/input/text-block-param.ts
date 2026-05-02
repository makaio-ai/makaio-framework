import { z } from 'zod';
import { BetaCacheControlEphemeralSchema, BetaTextCitationParamSchema } from '../../common/index.js';

/**
 * Text content block parameter
 * @see BetaTextBlockParam from \@anthropic-ai/sdk
 */
export const BetaTextBlockParamSchema = z.object({
  text: z.string(),
  type: z.literal('text'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
  citations: z.array(BetaTextCitationParamSchema).nullable().optional(),
});

export type BetaTextBlockParam = z.infer<typeof BetaTextBlockParamSchema>;
