import { z } from 'zod';
import {
  BetaBase64PDFSourceSchema,
  BetaCacheControlEphemeralSchema,
  BetaCitationsConfigParamSchema,
  BetaFileDocumentSourceSchema,
  BetaPlainTextSourceSchema,
  BetaURLPDFSourceSchema,
} from '../../common/index.js';
import { BetaTextBlockParamSchema } from './text-block-param.js';
import { BetaImageBlockParamSchema } from './image-block-param.js';

/**
 * Content block source for document blocks
 * @see BetaContentBlockSource from \@anthropic-ai/sdk
 */
export const BetaContentBlockSourceSchema = z.object({
  content: z.union([z.string(), z.array(z.union([BetaTextBlockParamSchema, BetaImageBlockParamSchema]))]),
  type: z.literal('content'),
});

/**
 * Document content block parameter
 * @see BetaRequestDocumentBlock from \@anthropic-ai/sdk
 */
export const BetaDocumentBlockParamSchema = z.object({
  source: z.union([
    BetaBase64PDFSourceSchema,
    BetaPlainTextSourceSchema,
    BetaContentBlockSourceSchema,
    BetaURLPDFSourceSchema,
    BetaFileDocumentSourceSchema,
  ]),
  type: z.literal('document'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
  citations: BetaCitationsConfigParamSchema.optional(),
  context: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

export type BetaContentBlockSource = z.infer<typeof BetaContentBlockSourceSchema>;
export type BetaDocumentBlockParam = z.infer<typeof BetaDocumentBlockParamSchema>;
