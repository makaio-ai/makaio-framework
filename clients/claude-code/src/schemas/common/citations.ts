import { z } from 'zod';

/**
 * Character-based citation location
 * @see BetaCitationCharLocation from \@anthropic-ai/sdk
 */
export const BetaCitationCharLocationSchema = z.object({
  cited_text: z.string(),
  document_index: z.number(),
  document_title: z.string().nullable(),
  end_char_index: z.number(),
  file_id: z.string().nullable().optional(),
  start_char_index: z.number(),
  type: z.literal('char_location'),
});

/**
 * Character-based citation location parameter (without file_id)
 * @see BetaCitationCharLocationParam from \@anthropic-ai/sdk
 */
export const BetaCitationCharLocationParamSchema = z.object({
  cited_text: z.string(),
  document_index: z.number(),
  document_title: z.string().nullable(),
  end_char_index: z.number(),
  start_char_index: z.number(),
  type: z.literal('char_location'),
});

/**
 * Page-based citation location
 * @see BetaCitationPageLocation from \@anthropic-ai/sdk
 */
export const BetaCitationPageLocationSchema = z.object({
  cited_text: z.string(),
  document_index: z.number(),
  document_title: z.string().nullable(),
  end_page_number: z.number(),
  file_id: z.string().nullable().optional(),
  start_page_number: z.number(),
  type: z.literal('page_location'),
});

/**
 * Page-based citation location parameter (without file_id)
 * @see BetaCitationPageLocationParam from \@anthropic-ai/sdk
 */
export const BetaCitationPageLocationParamSchema = z.object({
  cited_text: z.string(),
  document_index: z.number(),
  document_title: z.string().nullable(),
  end_page_number: z.number(),
  start_page_number: z.number(),
  type: z.literal('page_location'),
});

/**
 * Content block-based citation location
 * @see BetaCitationContentBlockLocation from \@anthropic-ai/sdk
 */
export const BetaCitationContentBlockLocationSchema = z.object({
  cited_text: z.string(),
  document_index: z.number(),
  document_title: z.string().nullable(),
  end_block_index: z.number(),
  file_id: z.string().nullable().optional(),
  start_block_index: z.number(),
  type: z.literal('content_block_location'),
});

/**
 * Content block-based citation location parameter (without file_id)
 * @see BetaCitationContentBlockLocationParam from \@anthropic-ai/sdk
 */
export const BetaCitationContentBlockLocationParamSchema = z.object({
  cited_text: z.string(),
  document_index: z.number(),
  document_title: z.string().nullable(),
  end_block_index: z.number(),
  start_block_index: z.number(),
  type: z.literal('content_block_location'),
});

/**
 * Web search result citation location
 * @see BetaCitationsWebSearchResultLocation from \@anthropic-ai/sdk
 */
export const BetaCitationsWebSearchResultLocationSchema = z.object({
  cited_text: z.string(),
  encrypted_index: z.string(),
  title: z.string().nullable().optional(),
  type: z.literal('web_search_result_location'),
  url: z.string(),
});

/**
 * Web search result citation location parameter
 * @see BetaCitationWebSearchResultLocationParam from \@anthropic-ai/sdk
 */
export const BetaCitationWebSearchResultLocationParamSchema = z.object({
  cited_text: z.string(),
  encrypted_index: z.string(),
  title: z.string().nullable().optional(),
  type: z.literal('web_search_result_location'),
  url: z.string(),
});

/**
 * Search result citation location
 * @see BetaCitationSearchResultLocation from \@anthropic-ai/sdk
 */
export const BetaCitationSearchResultLocationSchema = z.object({
  cited_text: z.string(),
  end_block_index: z.number(),
  search_result_index: z.number(),
  source: z.string(),
  start_block_index: z.number(),
  title: z.string().nullable().optional(),
  type: z.literal('search_result_location'),
});

/**
 * Search result citation location parameter
 * @see BetaCitationSearchResultLocationParam from \@anthropic-ai/sdk
 */
export const BetaCitationSearchResultLocationParamSchema = z.object({
  cited_text: z.string(),
  end_block_index: z.number(),
  search_result_index: z.number(),
  source: z.string(),
  start_block_index: z.number(),
  title: z.string().nullable().optional(),
  type: z.literal('search_result_location'),
});

/**
 * Union of all text citation types (for output)
 * @see BetaTextCitation from \@anthropic-ai/sdk
 */
export const BetaTextCitationSchema = z.discriminatedUnion('type', [
  BetaCitationCharLocationSchema,
  BetaCitationPageLocationSchema,
  BetaCitationContentBlockLocationSchema,
  BetaCitationsWebSearchResultLocationSchema,
  BetaCitationSearchResultLocationSchema,
]);

/**
 * Union of all text citation parameter types (for input)
 * @see BetaTextCitationParam from \@anthropic-ai/sdk
 */
export const BetaTextCitationParamSchema = z.discriminatedUnion('type', [
  BetaCitationCharLocationParamSchema,
  BetaCitationPageLocationParamSchema,
  BetaCitationContentBlockLocationParamSchema,
  BetaCitationWebSearchResultLocationParamSchema,
  BetaCitationSearchResultLocationParamSchema,
]);

/**
 * Citations delta event
 * @see BetaCitationsDelta from \@anthropic-ai/sdk
 */
export const BetaCitationsDeltaSchema = z.object({
  citation: BetaTextCitationSchema,
  type: z.literal('citations_delta'),
});

/**
 * Citations configuration parameter
 * @see BetaCitationsConfigParam from \@anthropic-ai/sdk
 */
export const BetaCitationsConfigParamSchema = z.object({
  enabled: z.boolean().optional(),
});

export type BetaCitationCharLocation = z.infer<typeof BetaCitationCharLocationSchema>;
export type BetaCitationCharLocationParam = z.infer<typeof BetaCitationCharLocationParamSchema>;
export type BetaCitationPageLocation = z.infer<typeof BetaCitationPageLocationSchema>;
export type BetaCitationPageLocationParam = z.infer<typeof BetaCitationPageLocationParamSchema>;
export type BetaCitationContentBlockLocation = z.infer<typeof BetaCitationContentBlockLocationSchema>;
export type BetaCitationContentBlockLocationParam = z.infer<typeof BetaCitationContentBlockLocationParamSchema>;
export type BetaCitationsWebSearchResultLocation = z.infer<typeof BetaCitationsWebSearchResultLocationSchema>;
export type BetaCitationWebSearchResultLocationParam = z.infer<typeof BetaCitationWebSearchResultLocationParamSchema>;
export type BetaCitationSearchResultLocation = z.infer<typeof BetaCitationSearchResultLocationSchema>;
export type BetaCitationSearchResultLocationParam = z.infer<typeof BetaCitationSearchResultLocationParamSchema>;
export type BetaTextCitation = z.infer<typeof BetaTextCitationSchema>;
export type BetaTextCitationParam = z.infer<typeof BetaTextCitationParamSchema>;
export type BetaCitationsDelta = z.infer<typeof BetaCitationsDeltaSchema>;
export type BetaCitationsConfigParam = z.infer<typeof BetaCitationsConfigParamSchema>;
