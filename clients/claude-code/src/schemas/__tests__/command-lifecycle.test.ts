import { describe, expect, it } from 'vitest';
import { SDKCommandLifecycleMessageSchema } from '../command-lifecycle.js';
import { SDKMessageSchema, isKnownSdkMessageForRouting } from '../sdk-message.js';

/**
 * Representative payload constructed from field names recovered from the
 * Claude Code 2.1.219 CLI binary string table. The `command_lifecycle` type
 * is absent from the \@anthropic-ai/claude-agent-sdk 0.2.131 typings, so this
 * payload is representative, not captured verbatim from a live run.
 */
const representativeCommandLifecycleEvent = {
  type: 'command_lifecycle',
  subtype: 'started',
  command_uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  uuid: 'c7e3f912-40a1-4b8e-9d2c-1a5b6f7c8d9e',
  session_id: '3f2e1d0c-b9a8-47f6-85e4-23c1d0e9f8a7',
};

describe('SDKCommandLifecycleMessageSchema', () => {
  it('accepts a representative payload', () => {
    expect(SDKCommandLifecycleMessageSchema.safeParse(representativeCommandLifecycleEvent).success).toBe(true);
  });

  it('participates in the sdk.event union', () => {
    expect(SDKMessageSchema.safeParse(representativeCommandLifecycleEvent).success).toBe(true);
  });

  it('requires the subtype field', () => {
    const { subtype, ...rest } = representativeCommandLifecycleEvent;
    expect(SDKCommandLifecycleMessageSchema.safeParse(rest).success).toBe(false);
  });

  it('accepts payloads without the optional command_uuid field', () => {
    const { command_uuid, ...rest } = representativeCommandLifecycleEvent;
    expect(SDKCommandLifecycleMessageSchema.safeParse(rest).success).toBe(true);
  });

  it('passes through unmodeled fields (permissive by design)', () => {
    const extended = { ...representativeCommandLifecycleEvent, unknown_future_field: 'value' };
    const result = SDKCommandLifecycleMessageSchema.safeParse(extended);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['unknown_future_field']).toBe('value');
    }
  });

  it('stays out of turn-state routing', () => {
    // Diagnostic-only: valid on sdk.event, but the turn-state machine must
    // never consume it, so the routing guard rejects it by design.
    expect(isKnownSdkMessageForRouting(representativeCommandLifecycleEvent)).toBe(false);
  });
});
