import { z } from 'zod';

/**
 * Base64-encoded image source
 * @see BetaBase64ImageSource from \@anthropic-ai/sdk
 */
export const BetaBase64ImageSourceSchema = z.object({
  data: z.string(),
  media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  type: z.literal('base64'),
});

/**
 * URL-based image source
 * @see BetaURLImageSource from \@anthropic-ai/sdk
 */
export const BetaURLImageSourceSchema = z.object({
  type: z.literal('url'),
  url: z.string(),
});

/**
 * File-based image source
 * @see BetaFileImageSource from \@anthropic-ai/sdk
 */
export const BetaFileImageSourceSchema = z.object({
  file_id: z.string(),
  type: z.literal('file'),
});

/**
 * Union of all image source types
 */
export const BetaImageSourceSchema = z.discriminatedUnion('type', [
  BetaBase64ImageSourceSchema,
  BetaURLImageSourceSchema,
  BetaFileImageSourceSchema,
]);

export type BetaBase64ImageSource = z.infer<typeof BetaBase64ImageSourceSchema>;
export type BetaURLImageSource = z.infer<typeof BetaURLImageSourceSchema>;
export type BetaFileImageSource = z.infer<typeof BetaFileImageSourceSchema>;
export type BetaImageSource = z.infer<typeof BetaImageSourceSchema>;
