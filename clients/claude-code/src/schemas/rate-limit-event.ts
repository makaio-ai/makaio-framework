import { z } from 'zod';
import { BaseSdkMessageSchema } from './base.js';

/**
 * Rate limit information for claude.ai subscription users.
 *
 * SDK Reference: SDKRateLimitInfo from \@anthropic-ai/claude-agent-sdk/sdk.d.ts
 */
export const SDKRateLimitInfoSchema = z.object({
  status: z.enum(['allowed', 'allowed_warning', 'rejected']),
  resetsAt: z.number().optional(),
  rateLimitType: z.enum(['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage']).optional(),
  utilization: z.number().optional(),
  overageStatus: z.enum(['allowed', 'allowed_warning', 'rejected']).optional(),
  overageResetsAt: z.number().optional(),
  overageDisabledReason: z
    .enum([
      'overage_not_provisioned',
      'org_level_disabled',
      'org_level_disabled_until',
      'out_of_credits',
      'seat_tier_level_disabled',
      'member_level_disabled',
      'seat_tier_zero_credit_limit',
      'group_zero_credit_limit',
      'member_zero_credit_limit',
      'org_service_level_disabled',
      'no_limits_configured',
      'fetch_error',
      'unknown',
    ])
    .optional(),
  isUsingOverage: z.boolean().optional(),
  surpassedThreshold: z.number().optional(),
});

/** Rate limit information payload type. */
export type SDKRateLimitInfo = z.infer<typeof SDKRateLimitInfoSchema>;

/**
 * Rate limit event emitted when rate limit info changes.
 *
 * Diagnostic-only: the turn-state machine never consumes this message, so it
 * is deliberately absent from `KNOWN_SDK_MESSAGE_TYPES`. It participates in
 * the SDK message union solely so `sdk.event` observers see a valid payload
 * instead of a schema violation for traffic the client knowingly emits.
 *
 * SDK Reference: SDKRateLimitEvent from \@anthropic-ai/claude-agent-sdk/sdk.d.ts
 */
export const SDKRateLimitEventMessageSchema = BaseSdkMessageSchema.extend({
  type: z.literal('rate_limit_event'),
  rate_limit_info: SDKRateLimitInfoSchema,
});

/** Rate limit event message type. */
export type SDKRateLimitEventMessage = z.infer<typeof SDKRateLimitEventMessageSchema>;
