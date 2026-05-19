/**
 * Conformance: SDKToolProgressMessage, SDKStatusMessage, and
 * SDKSessionStateChangedMessage must match their Claude Agent SDK shapes.
 *
 * These are the Tier 3 message types added to the SDKMessage union —
 * the subset of Claude's 28-type union that can be meaningfully mapped
 * from Makaio bus events.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  SDKToolProgressMessage as ClaudeSDKToolProgressMessage,
  SDKStatusMessage as ClaudeSDKStatusMessage,
  SDKSessionStateChangedMessage as ClaudeSDKSessionStateChangedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKToolProgressMessage,
  SDKStatusMessage,
  SDKSessionStateChangedMessage,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// 1. SDKToolProgressMessage
// ---------------------------------------------------------------------------

describe('SDKToolProgressMessage', () => {
  it('type is "tool_progress"', () => {
    expectTypeOf<SDKToolProgressMessage['type']>().toEqualTypeOf<ClaudeSDKToolProgressMessage['type']>();
  });

  it('tool_use_id is a required string', () => {
    expectTypeOf<SDKToolProgressMessage['tool_use_id']>().toEqualTypeOf<ClaudeSDKToolProgressMessage['tool_use_id']>();
  });

  it('tool_name is a required string', () => {
    expectTypeOf<SDKToolProgressMessage['tool_name']>().toEqualTypeOf<ClaudeSDKToolProgressMessage['tool_name']>();
  });

  it('parent_tool_use_id is string | null', () => {
    expectTypeOf<SDKToolProgressMessage['parent_tool_use_id']>().toEqualTypeOf<
      ClaudeSDKToolProgressMessage['parent_tool_use_id']
    >();
  });

  it('elapsed_time_seconds is a required number', () => {
    expectTypeOf<SDKToolProgressMessage['elapsed_time_seconds']>().toEqualTypeOf<
      ClaudeSDKToolProgressMessage['elapsed_time_seconds']
    >();
  });

  it('task_id is optional string', () => {
    expectTypeOf<SDKToolProgressMessage['task_id']>().toEqualTypeOf<ClaudeSDKToolProgressMessage['task_id']>();
  });

  it('Claude uuid (UUID) extends Makaio uuid (string)', () => {
    expectTypeOf<ClaudeSDKToolProgressMessage['uuid']>().toMatchTypeOf<SDKToolProgressMessage['uuid']>();
  });

  it('session_id matches', () => {
    expectTypeOf<SDKToolProgressMessage['session_id']>().toEqualTypeOf<ClaudeSDKToolProgressMessage['session_id']>();
  });
});

// ---------------------------------------------------------------------------
// 2. SDKStatusMessage
// ---------------------------------------------------------------------------

describe('SDKStatusMessage', () => {
  it('type is "system"', () => {
    expectTypeOf<SDKStatusMessage['type']>().toEqualTypeOf<ClaudeSDKStatusMessage['type']>();
  });

  it('subtype is "status"', () => {
    expectTypeOf<SDKStatusMessage['subtype']>().toEqualTypeOf<ClaudeSDKStatusMessage['subtype']>();
  });

  it('status matches the SDKStatus union', () => {
    expectTypeOf<SDKStatusMessage['status']>().toEqualTypeOf<ClaudeSDKStatusMessage['status']>();
  });

  it('permissionMode is optional and matches', () => {
    expectTypeOf<SDKStatusMessage['permissionMode']>().toEqualTypeOf<ClaudeSDKStatusMessage['permissionMode']>();
  });

  it('compact_result is optional', () => {
    expectTypeOf<SDKStatusMessage['compact_result']>().toEqualTypeOf<ClaudeSDKStatusMessage['compact_result']>();
  });

  it('compact_error is optional string', () => {
    expectTypeOf<SDKStatusMessage['compact_error']>().toEqualTypeOf<ClaudeSDKStatusMessage['compact_error']>();
  });

  it('Claude uuid extends Makaio uuid', () => {
    expectTypeOf<ClaudeSDKStatusMessage['uuid']>().toMatchTypeOf<SDKStatusMessage['uuid']>();
  });

  it('session_id matches', () => {
    expectTypeOf<SDKStatusMessage['session_id']>().toEqualTypeOf<ClaudeSDKStatusMessage['session_id']>();
  });
});

// ---------------------------------------------------------------------------
// 3. SDKSessionStateChangedMessage
// ---------------------------------------------------------------------------

describe('SDKSessionStateChangedMessage', () => {
  it('type is "system"', () => {
    expectTypeOf<SDKSessionStateChangedMessage['type']>().toEqualTypeOf<ClaudeSDKSessionStateChangedMessage['type']>();
  });

  it('subtype is "session_state_changed"', () => {
    expectTypeOf<SDKSessionStateChangedMessage['subtype']>().toEqualTypeOf<
      ClaudeSDKSessionStateChangedMessage['subtype']
    >();
  });

  it('state covers the same union on both sides', () => {
    expectTypeOf<SDKSessionStateChangedMessage['state']>().toEqualTypeOf<
      ClaudeSDKSessionStateChangedMessage['state']
    >();
  });

  it('Claude uuid extends Makaio uuid', () => {
    expectTypeOf<ClaudeSDKSessionStateChangedMessage['uuid']>().toMatchTypeOf<SDKSessionStateChangedMessage['uuid']>();
  });

  it('session_id matches', () => {
    expectTypeOf<SDKSessionStateChangedMessage['session_id']>().toEqualTypeOf<
      ClaudeSDKSessionStateChangedMessage['session_id']
    >();
  });
});
