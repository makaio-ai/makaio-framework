/**
 * Conformance: SDKResultMessage must be structurally compatible with the
 * Claude Agent SDK's SDKResultMessage (= SDKResultSuccess | SDKResultError).
 *
 * Claude SDK has a union with specific error subtypes and many required fields
 * that Makaio's single-type SDKResultMessage currently lacks.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { SDKResultMessage as ClaudeSDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// 1. Top-level structural assignability
// ---------------------------------------------------------------------------

describe('SDKResultMessage structural compatibility', () => {
  it('is assignable to ClaudeSDKResultMessage', () => {
    expectTypeOf<SDKResultMessage>().toMatchTypeOf<ClaudeSDKResultMessage>();
  });
});

// ---------------------------------------------------------------------------
// 2. Shared required fields present on both success and error
// ---------------------------------------------------------------------------

describe('SDKResultMessage shared fields', () => {
  it('type is "result"', () => {
    expectTypeOf<SDKResultMessage['type']>().toEqualTypeOf<ClaudeSDKResultMessage['type']>();
  });

  it('duration_ms is number', () => {
    expectTypeOf<SDKResultMessage['duration_ms']>().toEqualTypeOf<ClaudeSDKResultMessage['duration_ms']>();
  });

  it('duration_api_ms is number', () => {
    expectTypeOf<SDKResultMessage['duration_api_ms']>().toEqualTypeOf<ClaudeSDKResultMessage['duration_api_ms']>();
  });

  it('is_error is boolean', () => {
    expectTypeOf<SDKResultMessage['is_error']>().toEqualTypeOf<ClaudeSDKResultMessage['is_error']>();
  });

  it('num_turns is number', () => {
    expectTypeOf<SDKResultMessage['num_turns']>().toEqualTypeOf<ClaudeSDKResultMessage['num_turns']>();
  });

  it('total_cost_usd is number', () => {
    expectTypeOf<SDKResultMessage['total_cost_usd']>().toEqualTypeOf<ClaudeSDKResultMessage['total_cost_usd']>();
  });

  it('stop_reason is string | null', () => {
    expectTypeOf<SDKResultMessage['stop_reason']>().toEqualTypeOf<ClaudeSDKResultMessage['stop_reason']>();
  });

  it('usage is NonNullableUsage-compatible', () => {
    expectTypeOf<SDKResultMessage['usage']>().toMatchTypeOf<ClaudeSDKResultMessage['usage']>();
  });

  it('permission_denials is array', () => {
    expectTypeOf<SDKResultMessage['permission_denials']>().toMatchTypeOf<
      ClaudeSDKResultMessage['permission_denials']
    >();
  });

  it('modelUsage is Record<string, ModelUsage>', () => {
    expectTypeOf<SDKResultMessage['modelUsage']>().toMatchTypeOf<ClaudeSDKResultMessage['modelUsage']>();
  });
});

// ---------------------------------------------------------------------------
// 3. Subtype discriminant covers Claude SDK subtypes
//    Claude: 'success' | 'error_during_execution' | 'error_max_turns' | ...
//    Our subtype must be at least as wide.
// ---------------------------------------------------------------------------

describe('SDKResultMessage subtype compatibility', () => {
  it('subtype is assignable to Claude subtype', () => {
    expectTypeOf<SDKResultMessage['subtype']>().toMatchTypeOf<ClaudeSDKResultMessage['subtype']>();
  });
});
