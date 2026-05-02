import { z } from 'zod';

/**
 * Information about the container used in the request (for the code execution tool)
 * @see BetaContainer from \@anthropic-ai/sdk
 */
export const BetaContainerSchema = z.object({
  /**
   * Identifier for the container used in this request
   */
  id: z.string(),
  /**
   * The time at which the container will expire.
   */
  expires_at: z.string(),
});

export type BetaContainer = z.infer<typeof BetaContainerSchema>;
