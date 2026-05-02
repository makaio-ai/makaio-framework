import { z } from 'zod';

/**
 * Base64-encoded PDF document source
 * @see BetaBase64PDFSource from \@anthropic-ai/sdk
 */
export const BetaBase64PDFSourceSchema = z.object({
  data: z.string(),
  media_type: z.literal('application/pdf'),
  type: z.literal('base64'),
});

/**
 * URL-based PDF document source
 * @see BetaURLPDFSource from \@anthropic-ai/sdk
 */
export const BetaURLPDFSourceSchema = z.object({
  type: z.literal('url'),
  url: z.string(),
});

/**
 * File-based document source
 * @see BetaFileDocumentSource from \@anthropic-ai/sdk
 */
export const BetaFileDocumentSourceSchema = z.object({
  file_id: z.string(),
  type: z.literal('file'),
});

/**
 * Plain text document source
 * @see BetaPlainTextSource from \@anthropic-ai/sdk
 */
export const BetaPlainTextSourceSchema = z.object({
  data: z.string(),
  media_type: z.literal('text/plain'),
  type: z.literal('text'),
});

export type BetaBase64PDFSource = z.infer<typeof BetaBase64PDFSourceSchema>;
export type BetaURLPDFSource = z.infer<typeof BetaURLPDFSourceSchema>;
export type BetaFileDocumentSource = z.infer<typeof BetaFileDocumentSourceSchema>;
export type BetaPlainTextSource = z.infer<typeof BetaPlainTextSourceSchema>;
