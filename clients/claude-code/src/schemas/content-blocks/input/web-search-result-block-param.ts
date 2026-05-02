import { z } from 'zod';

/**
 * Web search result block parameter
 * @see BetaWebSearchResultBlockParam from \@anthropic-ai/sdk
 */
export const BetaWebSearchResultBlockParamSchema = z.object({
  encrypted_content: z.string(),
  title: z.string(),
  type: z.literal('web_search_result'),
  url: z.string(),
  page_age: z.string().nullable().optional(),
});

export type BetaWebSearchResultBlockParam = z.infer<typeof BetaWebSearchResultBlockParamSchema>;
