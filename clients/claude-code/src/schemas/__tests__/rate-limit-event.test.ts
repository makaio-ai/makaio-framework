import { describe, expect, it } from 'vitest';
import { SDKRateLimitEventMessageSchema } from '../rate-limit-event.js';
import { SDKMessageSchema, isKnownSdkMessageForRouting } from '../sdk-message.js';

/**
 * Payload shape captured verbatim from a live claude-code-cli conformance run
 * (only identifiers replaced). Prior to the union widening, every such event
 * was reported as a schema violation on `sdk.event`.
 */
const liveRateLimitEvent = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1785162000,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    isUsingOverage: false,
  },
  uuid: 'b9129cf7-b0dc-47fb-a983-6ce9a8da3daf',
  session_id: '55c4fbc7-2340-46ab-af5b-e8a8c1abf3e7',
};

describe('SDKRateLimitEventMessageSchema', () => {
  it('accepts the live CLI payload', () => {
    expect(SDKRateLimitEventMessageSchema.safeParse(liveRateLimitEvent).success).toBe(true);
  });

  it('participates in the sdk.event union', () => {
    expect(SDKMessageSchema.safeParse(liveRateLimitEvent).success).toBe(true);
  });

  it('requires the rate_limit_info status', () => {
    const { rate_limit_info, ...rest } = liveRateLimitEvent;
    expect(SDKRateLimitEventMessageSchema.safeParse(rest).success).toBe(false);
    expect(
      SDKRateLimitEventMessageSchema.safeParse({
        ...rest,
        rate_limit_info: { ...rate_limit_info, status: 'not-a-status' },
      }).success,
    ).toBe(false);
  });

  it('stays out of turn-state routing', () => {
    // Diagnostic-only: valid on sdk.event, but the turn-state machine must
    // never consume it, so the routing guard rejects it by design.
    expect(isKnownSdkMessageForRouting(liveRateLimitEvent)).toBe(false);
  });
});
