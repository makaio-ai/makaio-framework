import { describe, expect, it } from 'vitest';
import { SDKResultMessageSchema } from '../result-message.js';

const baseResult = {
  type: 'result',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0 },
    service_tier: 'standard',
  },
  modelUsage: {},
  permission_denials: [],
  uuid: 'result-1',
  session_id: 'session-1',
};

describe('SDKResultMessageSchema', () => {
  it('accepts native structured output on successful result messages', () => {
    const result = SDKResultMessageSchema.safeParse({
      ...baseResult,
      subtype: 'success',
      result: '',
      structured_output: { ok: true },
    });

    expect(result.success).toBe(true);
  });

  it('accepts primitive JSON structured output values', () => {
    const result = SDKResultMessageSchema.safeParse({
      ...baseResult,
      subtype: 'success',
      result: '',
      structured_output: 'ready',
    });

    expect(result.success).toBe(true);
  });

  it('accepts structured-output retry exhaustion as a result error subtype', () => {
    const result = SDKResultMessageSchema.safeParse({
      ...baseResult,
      subtype: 'error_max_structured_output_retries',
      is_error: true,
      errors: ['structured output retry limit reached'],
      stop_reason: null,
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(
      expect.objectContaining({
        errors: ['structured output retry limit reached'],
        stop_reason: null,
      }),
    );
  });
});
