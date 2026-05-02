import { z } from 'zod';
import { BetaThinkingBlockSchema } from '../output/index.js';

/**
 * Thinking content block parameter
 * @see BetaThinkingBlockParam from \@anthropic-ai/sdk
 */
export const BetaThinkingBlockParamSchema = BetaThinkingBlockSchema.extend({});

export type BetaThinkingBlockParam = z.infer<typeof BetaThinkingBlockParamSchema>;
