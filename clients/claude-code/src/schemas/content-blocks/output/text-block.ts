import { z } from 'zod';
import { BetaTextCitationSchema } from '../../common/index.js';

/**
 * Text content block
 * @see BetaTextBlock from \@anthropic-ai/sdk
 */
export const BetaTextBlockSchema = z.object({
  citations: z.array(BetaTextCitationSchema).nullable().optional(),
  text: z.string(),
  type: z.literal('text'),
});

export type BetaTextBlock = z.infer<typeof BetaTextBlockSchema>;
