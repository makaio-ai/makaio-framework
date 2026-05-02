import { z } from 'zod';

/**
 * Web search result block
 * @see BetaWebSearchResultBlock from \@anthropic-ai/sdk
 */
export const BetaWebSearchResultBlockSchema = z.object({
  encrypted_content: z.string(),
  page_age: z.string().nullable().optional(),
  title: z.string(),
  type: z.literal('web_search_result'),
  url: z.string(),
});

/**
 * Web search tool result error code
 * @see BetaWebSearchToolResultErrorCode from \@anthropic-ai/sdk
 */
export const BetaWebSearchToolResultErrorCodeSchema = z.enum([
  'invalid_tool_input',
  'unavailable',
  'max_uses_exceeded',
  'too_many_requests',
  'query_too_long',
]);

/**
 * Web search tool result error
 * @see BetaWebSearchToolResultError from \@anthropic-ai/sdk
 */
export const BetaWebSearchToolResultErrorSchema = z.object({
  error_code: BetaWebSearchToolResultErrorCodeSchema,
  type: z.literal('web_search_tool_result_error'),
});

/**
 * Web search tool result block content
 * @see BetaWebSearchToolResultBlockContent from \@anthropic-ai/sdk
 */
export const BetaWebSearchToolResultBlockContentSchema = z.union([
  BetaWebSearchToolResultErrorSchema,
  z.array(BetaWebSearchResultBlockSchema),
]);

/**
 * Web search tool result block
 * @see BetaWebSearchToolResultBlock from \@anthropic-ai/sdk
 */
export const BetaWebSearchToolResultBlockSchema = z.object({
  content: BetaWebSearchToolResultBlockContentSchema,
  tool_use_id: z.string(),
  type: z.literal('web_search_tool_result'),
});

export type BetaWebSearchResultBlock = z.infer<typeof BetaWebSearchResultBlockSchema>;
export type BetaWebSearchToolResultErrorCode = z.infer<typeof BetaWebSearchToolResultErrorCodeSchema>;
export type BetaWebSearchToolResultError = z.infer<typeof BetaWebSearchToolResultErrorSchema>;
export type BetaWebSearchToolResultBlockContent = z.infer<typeof BetaWebSearchToolResultBlockContentSchema>;
export type BetaWebSearchToolResultBlock = z.infer<typeof BetaWebSearchToolResultBlockSchema>;
