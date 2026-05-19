/**
 * Conformance: SDKAssistantMessage must be structurally compatible with the
 * Claude Agent SDK's SDKAssistantMessage.
 *
 * The Claude SDK's assistant message wraps a full BetaMessage (the Anthropic
 * API response object). Our message field carries a BetaMessage-compatible
 * subset — the fields that pattern-(A) consumers actually access.
 *
 * Assertions use field-level checks because our message payload is an
 * intentional subset (not the full BetaMessage), and our ContentBlock union
 * covers 3 of ~15 BetaContentBlock variants. Full-type assignability would
 * require mirroring every Beta block type.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { SDKAssistantMessage as ClaudeSDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SDKAssistantMessage } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// 1. Top-level discriminants and identifiers
// ---------------------------------------------------------------------------

describe('SDKAssistantMessage discriminants and identifiers', () => {
  it('type is "assistant"', () => {
    expectTypeOf<SDKAssistantMessage['type']>().toEqualTypeOf<ClaudeSDKAssistantMessage['type']>();
  });

  it('session_id is string', () => {
    expectTypeOf<SDKAssistantMessage['session_id']>().toEqualTypeOf<ClaudeSDKAssistantMessage['session_id']>();
  });

  it('uuid is string-compatible with Claude UUID', () => {
    expectTypeOf<ClaudeSDKAssistantMessage['uuid']>().toMatchTypeOf<SDKAssistantMessage['uuid']>();
  });
});

// ---------------------------------------------------------------------------
// 2. message field carries BetaMessage-compatible shape
// ---------------------------------------------------------------------------

describe('SDKAssistantMessage.message is BetaMessage-compatible', () => {
  it('message.type is the literal "message"', () => {
    expectTypeOf<SDKAssistantMessage['message']['type']>().toEqualTypeOf<'message'>();
  });

  it('message.id is a string', () => {
    expectTypeOf<SDKAssistantMessage['message']['id']>().toEqualTypeOf<string>();
  });

  it('message.role is the literal "assistant"', () => {
    expectTypeOf<SDKAssistantMessage['message']['role']>().toEqualTypeOf<'assistant'>();
  });

  it('message.model is a string', () => {
    expectTypeOf<SDKAssistantMessage['message']['model']>().toEqualTypeOf<string>();
  });

  it('message.stop_reason is string | null', () => {
    expectTypeOf<SDKAssistantMessage['message']['stop_reason']>().toEqualTypeOf<string | null>();
  });

  it('message.stop_sequence is string | null', () => {
    expectTypeOf<SDKAssistantMessage['message']['stop_sequence']>().toEqualTypeOf<string | null>();
  });

  it('message.content is an array', () => {
    expectTypeOf<SDKAssistantMessage['message']['content']>().toMatchTypeOf<unknown[]>();
  });
});

// ---------------------------------------------------------------------------
// 3. parent_tool_use_id is required (string | null)
// ---------------------------------------------------------------------------

describe('SDKAssistantMessage.parent_tool_use_id', () => {
  it('exists and is string | null', () => {
    expectTypeOf<SDKAssistantMessage['parent_tool_use_id']>().toEqualTypeOf<
      ClaudeSDKAssistantMessage['parent_tool_use_id']
    >();
  });
});

// ---------------------------------------------------------------------------
// 4. error field (optional SDKAssistantMessageError)
// ---------------------------------------------------------------------------

describe('SDKAssistantMessage.error', () => {
  it('exists and matches Claude SDK error type', () => {
    expectTypeOf<SDKAssistantMessage['error']>().toEqualTypeOf<ClaudeSDKAssistantMessage['error']>();
  });
});
