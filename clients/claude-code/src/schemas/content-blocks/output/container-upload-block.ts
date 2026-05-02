import { z } from 'zod';

/**
 * Container upload content block
 * @see BetaContainerUploadBlock from \@anthropic-ai/sdk
 */
export const BetaContainerUploadBlockSchema = z.object({
  file_id: z.string(),
  type: z.literal('container_upload'),
});

export type BetaContainerUploadBlock = z.infer<typeof BetaContainerUploadBlockSchema>;
