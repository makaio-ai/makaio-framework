import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';
import { BetaWebSearchResultBlockParamSchema } from './web-search-result-block-param.js';

/**
 * Web search tool result error
 * @see BetaWebSearchToolRequestError from \@anthropic-ai/sdk
 */
export const BetaWebSearchToolRequestErrorSchema = z.object({
  error_code: z.enum(['invalid_tool_input', 'unavailable', 'max_uses_exceeded', 'too_many_requests', 'query_too_long']),
  type: z.literal('web_search_tool_result_error'),
});

/**
 * Web search tool result content
 * @see BetaWebSearchToolResultBlockParamContent from \@anthropic-ai/sdk
 */
export const BetaWebSearchToolResultBlockParamContentSchema = z.union([
  z.array(BetaWebSearchResultBlockParamSchema),
  BetaWebSearchToolRequestErrorSchema,
]);

/**
 * Web search tool result block parameter
 * @see BetaWebSearchToolResultBlockParam from \@anthropic-ai/sdk
 */
export const BetaWebSearchToolResultBlockParamSchema = z.object({
  content: BetaWebSearchToolResultBlockParamContentSchema,
  tool_use_id: z.string(),
  type: z.literal('web_search_tool_result'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
});

export type BetaWebSearchToolRequestError = z.infer<typeof BetaWebSearchToolRequestErrorSchema>;
export type BetaWebSearchToolResultBlockParamContent = z.infer<typeof BetaWebSearchToolResultBlockParamContentSchema>;
export type BetaWebSearchToolResultBlockParam = z.infer<typeof BetaWebSearchToolResultBlockParamSchema>;
