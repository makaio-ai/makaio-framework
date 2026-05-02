import { z } from 'zod';
import { BetaCacheControlEphemeralSchema } from '../../common/index.js';

/**
 * A content block that represents a file to be uploaded to the container
 * Files uploaded via this block will be available in the container's input directory.
 * @see BetaContainerUploadBlockParam from \@anthropic-ai/sdk
 */
export const BetaContainerUploadBlockParamSchema = z.object({
  file_id: z.string(),
  type: z.literal('container_upload'),
  /**
   * Create a cache control breakpoint at this content block.
   */
  cache_control: BetaCacheControlEphemeralSchema.nullable().optional(),
});

export type BetaContainerUploadBlockParam = z.infer<typeof BetaContainerUploadBlockParamSchema>;
