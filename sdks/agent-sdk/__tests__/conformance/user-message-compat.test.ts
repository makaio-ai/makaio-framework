/**
 * Conformance: SDKUserMessage must match the Claude Agent SDK shape.
 *
 * The Claude SDK SDKUserMessage uses `MessageParam` for the `message` field
 * and carries several optional metadata fields. Our type mirrors the required
 * fields exactly and provides the same optional fields.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { SDKUserMessage as ClaudeSDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// 1. Discriminant field
// ---------------------------------------------------------------------------

describe('SDKUserMessage discriminant', () => {
  it('type is "user"', () => {
    expectTypeOf<SDKUserMessage['type']>().toEqualTypeOf<ClaudeSDKUserMessage['type']>();
  });
});

// ---------------------------------------------------------------------------
// 2. Required fields
// ---------------------------------------------------------------------------

describe('SDKUserMessage required fields', () => {
  it('message.role matches Claude (includes "user")', () => {
    expectTypeOf<SDKUserMessage['message']['role']>().toEqualTypeOf<ClaudeSDKUserMessage['message']['role']>();
  });

  it('parent_tool_use_id is required string | null', () => {
    expectTypeOf<SDKUserMessage['parent_tool_use_id']>().toEqualTypeOf<ClaudeSDKUserMessage['parent_tool_use_id']>();
  });
});

// ---------------------------------------------------------------------------
// 3. Optional metadata fields
// ---------------------------------------------------------------------------

describe('SDKUserMessage optional fields', () => {
  it('isSynthetic is optional boolean', () => {
    expectTypeOf<SDKUserMessage['isSynthetic']>().toEqualTypeOf<ClaudeSDKUserMessage['isSynthetic']>();
  });

  it('tool_use_result is optional unknown', () => {
    expectTypeOf<SDKUserMessage['tool_use_result']>().toEqualTypeOf<ClaudeSDKUserMessage['tool_use_result']>();
  });

  it('priority matches the Claude union', () => {
    expectTypeOf<SDKUserMessage['priority']>().toEqualTypeOf<ClaudeSDKUserMessage['priority']>();
  });

  it('origin matches the Claude SDKMessageOrigin union', () => {
    expectTypeOf<SDKUserMessage['origin']>().toEqualTypeOf<ClaudeSDKUserMessage['origin']>();
  });

  it('shouldQuery is optional boolean', () => {
    expectTypeOf<SDKUserMessage['shouldQuery']>().toEqualTypeOf<ClaudeSDKUserMessage['shouldQuery']>();
  });

  it('timestamp is optional string', () => {
    expectTypeOf<SDKUserMessage['timestamp']>().toEqualTypeOf<ClaudeSDKUserMessage['timestamp']>();
  });
});

// ---------------------------------------------------------------------------
// 4. Identifier fields (optional on user messages)
// ---------------------------------------------------------------------------

describe('SDKUserMessage identifier compatibility', () => {
  it('uuid is optional, Claude UUID extends our string', () => {
    expectTypeOf<ClaudeSDKUserMessage['uuid']>().toMatchTypeOf<SDKUserMessage['uuid']>();
  });

  it('session_id is optional string on both sides', () => {
    expectTypeOf<SDKUserMessage['session_id']>().toEqualTypeOf<ClaudeSDKUserMessage['session_id']>();
  });
});

// ---------------------------------------------------------------------------
// 5. message.content compatibility
//    Claude uses MessageParam which has `content: string | Array<ContentBlockParam>`.
//    Our type must accept the same shape.
// ---------------------------------------------------------------------------

describe('SDKUserMessage message.content', () => {
  it('content accepts string', () => {
    expectTypeOf<string>().toMatchTypeOf<SDKUserMessage['message']['content']>();
  });

  it('content is a string-or-array envelope matching Claude shape', () => {
    // Deep element-level compatibility (ContentBlock ↔ ContentBlockParam) is
    // covered by content-block-compat.test.ts. Here we verify the envelope:
    // both sides are `string | SomeArray`.
    type OurContent = SDKUserMessage['message']['content'];
    type ClaudeContent = ClaudeSDKUserMessage['message']['content'];
    // Both accept string
    expectTypeOf<string>().toMatchTypeOf<OurContent>();
    expectTypeOf<string>().toMatchTypeOf<ClaudeContent>();
    // Neither is string-only (both have an array branch)
    expectTypeOf<OurContent>().not.toBeString();
    expectTypeOf<ClaudeContent>().not.toBeString();
  });
});
