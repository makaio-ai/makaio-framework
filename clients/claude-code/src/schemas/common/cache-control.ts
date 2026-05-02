import { z } from 'zod';

/**
 * Cache control configuration for ephemeral caching
 * @see BetaCacheControlEphemeral from \@anthropic-ai/sdk
 */
export const BetaCacheControlEphemeralSchema = z.object({
  type: z.literal('ephemeral'),
  /**
   * The time-to-live for the cache control breakpoint.
   *
   * This may be one the following values:
   *
   * - `5m`: 5 minutes
   * - `1h`: 1 hour
   *
   * Defaults to `5m`.
   */
  ttl: z.enum(['5m', '1h']).optional(),
});

export type BetaCacheControlEphemeral = z.infer<typeof BetaCacheControlEphemeralSchema>;
