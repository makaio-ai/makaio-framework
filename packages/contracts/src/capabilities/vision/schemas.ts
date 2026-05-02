import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Request to analyze an image.
 */
export const VisionAnalysisRequestSchema = z.object({
  /** Image source: file path, base64 data URI, or URL */
  image: z.string(),
  /** Optional prompt to guide the analysis (default: "Describe this image") */
  prompt: z.string().optional(),
});

/**
 * Result of image analysis.
 */
export const VisionAnalysisResultSchema = z.object({
  /** Text description of the image */
  description: z.string(),
  /** Optional confidence score (0-1) */
  confidence: z.number().min(0).max(1).optional(),
});

export type VisionAnalysisRequest = z.infer<typeof VisionAnalysisRequestSchema>;
export type VisionAnalysisResult = z.infer<typeof VisionAnalysisResultSchema>;

/**
 * Vision capability subjects.
 *
 * Subject: `vision.analyze`
 * Type: Request (RPC)
 */
export const VisionSchemas = {
  analyze: {
    request: VisionAnalysisRequestSchema,
    response: VisionAnalysisResultSchema,
  },
} satisfies SchemaRecord;
