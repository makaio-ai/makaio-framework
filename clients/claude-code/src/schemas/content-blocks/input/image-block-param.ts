import { z } from 'zod';
import { BetaCacheControlEphemeralSchema, BetaImageSourceSchema } from '../../common/index.js';

/**
 * Image content block parameter
 * @see BetaImageBlockParam from \@anthropic-ai/sdk
 */
export const BetaImageBlockParamSchema = z.object({
  source: BetaImageSourceSchema,
  type: z.literal('image'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
});

export type BetaImageBlockParam = z.infer<typeof BetaImageBlockParamSchema>;
