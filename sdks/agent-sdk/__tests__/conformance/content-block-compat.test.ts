/**
 * Conformance: ContentBlock must be a discriminated union where fields are
 * required after narrowing, matching the BetaContentBlock structure from the
 * Anthropic SDK.
 *
 * In the Claude Agent SDK, assistant message content is Array<BetaContentBlock>,
 * a union of ~15 block types. After narrowing on block.type === 'tool_use',
 * fields like id, name, input are required — not optional.
 *
 * We don't need to cover all 15 block types, but the core three (text,
 * thinking, tool_use) must narrow correctly.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  BetaTextBlock,
  BetaThinkingBlock,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs';
import type { ContentBlock } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Helper: extract a specific variant from the ContentBlock union
// ---------------------------------------------------------------------------

type TextBlock = Extract<ContentBlock, { type: 'text' }>;
type ThinkingBlock = Extract<ContentBlock, { type: 'thinking' }>;
type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>;

// ---------------------------------------------------------------------------
// 1. ContentBlock must be a union (Extract should produce distinct types)
// ---------------------------------------------------------------------------

describe('ContentBlock is a discriminated union', () => {
  it('Extract<ContentBlock, {type: "text"}> is a distinct type', () => {
    expectTypeOf<TextBlock>().not.toEqualTypeOf<ContentBlock>();
  });

  it('Extract<ContentBlock, {type: "tool_use"}> is a distinct type', () => {
    expectTypeOf<ToolUseBlock>().not.toEqualTypeOf<ContentBlock>();
  });

  it('Extract<ContentBlock, {type: "thinking"}> is a distinct type', () => {
    expectTypeOf<ThinkingBlock>().not.toEqualTypeOf<ContentBlock>();
  });
});

// ---------------------------------------------------------------------------
// 2. TextBlock: after narrowing, text is required string
// ---------------------------------------------------------------------------

describe('TextBlock (narrowed) field requirements', () => {
  it('text is required string (not optional)', () => {
    expectTypeOf<TextBlock['text']>().toEqualTypeOf<string>();
  });

  it('carries the same structural fields as BetaTextBlock', () => {
    expectTypeOf<TextBlock['type']>().toEqualTypeOf<BetaTextBlock['type']>();
    expectTypeOf<TextBlock['text']>().toEqualTypeOf<BetaTextBlock['text']>();
    // citations: our TextCitation is an open shape; BetaTextCitation is a closed
    // union. We verify the array|null envelope matches, not the element type.
    expectTypeOf<TextBlock['citations']>().toMatchTypeOf<unknown[] | null>();
  });
});

// ---------------------------------------------------------------------------
// 3. ThinkingBlock: after narrowing, thinking is required string
// ---------------------------------------------------------------------------

describe('ThinkingBlock (narrowed) field requirements', () => {
  it('thinking is required string (not optional)', () => {
    expectTypeOf<ThinkingBlock['thinking']>().toEqualTypeOf<string>();
  });

  it('is assignable to BetaThinkingBlock', () => {
    expectTypeOf<ThinkingBlock>().toMatchTypeOf<BetaThinkingBlock>();
  });
});

// ---------------------------------------------------------------------------
// 4. ToolUseBlock: after narrowing, id/name/input are required
// ---------------------------------------------------------------------------

describe('ToolUseBlock (narrowed) field requirements', () => {
  it('id is required string', () => {
    expectTypeOf<ToolUseBlock['id']>().toEqualTypeOf<string>();
  });

  it('name is required string', () => {
    expectTypeOf<ToolUseBlock['name']>().toEqualTypeOf<string>();
  });

  it('input is required Record<string, unknown>', () => {
    expectTypeOf<ToolUseBlock['input']>().toEqualTypeOf<Record<string, unknown>>();
  });

  it('is assignable to BetaToolUseBlock', () => {
    expectTypeOf<ToolUseBlock>().toMatchTypeOf<BetaToolUseBlock>();
  });
});

// ---------------------------------------------------------------------------
// 5. tool_result must NOT be a ContentBlock variant
//    (Tool results are user-role messages in the Claude SDK, not assistant
//    content blocks.)
// ---------------------------------------------------------------------------

describe('tool_result is not a ContentBlock variant', () => {
  it('Extract<ContentBlock, {type: "tool_result"}> is never', () => {
    expectTypeOf<Extract<ContentBlock, { type: 'tool_result' }>>().toEqualTypeOf<never>();
  });
});
