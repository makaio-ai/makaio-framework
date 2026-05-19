/**
 * Consumer-pattern conformance: verifies that the same message-processing
 * code type-checks identically against both the Claude Agent SDK and the
 * Makaio Agent SDK type surface.
 *
 * This is the acid test for drop-in compatibility. Each test defines an
 * inline processing pattern typed against Claude's types, then asserts
 * that our types match at the field level.
 *
 * We test four consumer patterns observed in the wild:
 *   (A) for-await + switch(msg.type) dispatch loop
 *   (B) tool_use block extraction from assistant messages
 *   (C) result message branching on subtype
 *   (D) BetaMessage field access (stop_reason, model, id)
 *
 * Known intentional divergences (documented, not bugs):
 *   - Our ContentBlock has 3 variants; BetaContentBlock has 16.
 *     Consumers filtering on type === 'tool_use' | 'text' | 'thinking'
 *     work identically; consumers matching server-tool or MCP block
 *     types would never see those from Makaio anyway.
 *   - Our stop_reason is `string | null` (wider than BetaStopReason).
 *     Consumers switching on stop_reason values work identically for
 *     'end_turn', 'tool_use', 'max_tokens'; we may emit adapter-specific
 *     stop reasons that aren't in the literal union.
 *   - Our SDKMessage union includes SDKToolResultMessage which Claude's
 *     doesn't. Claude consumers' default/fallthrough case handles this.
 */

import { describe, expectTypeOf, it } from 'vitest';

import type {
  SDKAssistantMessage as ClaudeSDKAssistantMessage,
  SDKResultMessage as ClaudeSDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  SDKAssistantMessage as MakaioSDKAssistantMessage,
  SDKResultMessage as MakaioSDKResultMessage,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// (A) Pattern: for-await dispatch loop
//     Consumer does: for await (const msg of query) { switch(msg.type) ... }
// ---------------------------------------------------------------------------

describe('Pattern A: message dispatch loop', () => {
  it('assistant message discriminant is identical', () => {
    expectTypeOf<MakaioSDKAssistantMessage['type']>().toEqualTypeOf<ClaudeSDKAssistantMessage['type']>();
  });

  it('result message discriminant is identical', () => {
    expectTypeOf<MakaioSDKResultMessage['type']>().toEqualTypeOf<ClaudeSDKResultMessage['type']>();
  });

  it('session_id field matches on assistant messages', () => {
    expectTypeOf<MakaioSDKAssistantMessage['session_id']>().toEqualTypeOf<ClaudeSDKAssistantMessage['session_id']>();
  });
});

// ---------------------------------------------------------------------------
// (B) Pattern: tool_use block extraction
//     Consumer does: msg.message.content.filter(b => b.type === 'tool_use')
//     then accesses b.name, b.id, b.input
// ---------------------------------------------------------------------------

describe('Pattern B: tool_use block extraction', () => {
  it('tool_use blocks carry name, id, and input on both sides', () => {
    type MakaioToolUse = Extract<MakaioSDKAssistantMessage['message']['content'][number], { type: 'tool_use' }>;
    type ClaudeToolUse = Extract<ClaudeSDKAssistantMessage['message']['content'][number], { type: 'tool_use' }>;

    expectTypeOf<MakaioToolUse['name']>().toEqualTypeOf<ClaudeToolUse['name']>();
    expectTypeOf<MakaioToolUse['id']>().toEqualTypeOf<ClaudeToolUse['id']>();
    // Our input is Record<string, unknown>, Claude's is `unknown` — ours is narrower
    expectTypeOf<MakaioToolUse['input']>().toMatchTypeOf<ClaudeToolUse['input']>();
  });

  it('text blocks carry text field on both sides', () => {
    type MakaioText = Extract<MakaioSDKAssistantMessage['message']['content'][number], { type: 'text' }>;
    type ClaudeText = Extract<ClaudeSDKAssistantMessage['message']['content'][number], { type: 'text' }>;

    expectTypeOf<MakaioText['text']>().toEqualTypeOf<ClaudeText['text']>();
  });

  it('thinking blocks carry thinking and signature on both sides', () => {
    type MakaioThinking = Extract<MakaioSDKAssistantMessage['message']['content'][number], { type: 'thinking' }>;
    type ClaudeThinking = Extract<ClaudeSDKAssistantMessage['message']['content'][number], { type: 'thinking' }>;

    expectTypeOf<MakaioThinking['thinking']>().toEqualTypeOf<ClaudeThinking['thinking']>();
    expectTypeOf<MakaioThinking['signature']>().toEqualTypeOf<ClaudeThinking['signature']>();
  });

  it('content block type discriminant covers the 3 consumer-relevant variants', () => {
    type MakaioBlockTypes = MakaioSDKAssistantMessage['message']['content'][number]['type'];
    // Our 3 variants are a subset of Claude's 16 — the ones consumers actually switch on
    expectTypeOf<MakaioBlockTypes>().toMatchTypeOf<'text' | 'thinking' | 'tool_use'>();
    expectTypeOf<'text' | 'thinking' | 'tool_use'>().toEqualTypeOf<MakaioBlockTypes>();
  });
});

// ---------------------------------------------------------------------------
// (C) Pattern: result message branching
//     Consumer does: if (msg.subtype === 'success') msg.result
//                    else msg.errors
// ---------------------------------------------------------------------------

describe('Pattern C: result message branching', () => {
  it('result message subtype union matches Claude', () => {
    expectTypeOf<MakaioSDKResultMessage['subtype']>().toEqualTypeOf<ClaudeSDKResultMessage['subtype']>();
  });

  it('success branch has result field', () => {
    type MakaioSuccess = Extract<MakaioSDKResultMessage, { subtype: 'success' }>;
    type ClaudeSuccess = Extract<ClaudeSDKResultMessage, { subtype: 'success' }>;
    expectTypeOf<MakaioSuccess['result']>().toEqualTypeOf<ClaudeSuccess['result']>();
  });

  it('error branch has errors field', () => {
    type MakaioError = Extract<MakaioSDKResultMessage, { subtype: 'error_during_execution' }>;
    type ClaudeError = Extract<ClaudeSDKResultMessage, { subtype: 'error_during_execution' }>;
    expectTypeOf<MakaioError['errors']>().toEqualTypeOf<ClaudeError['errors']>();
  });

  it('usage fields match on result messages', () => {
    expectTypeOf<MakaioSDKResultMessage['usage']>().toMatchTypeOf<ClaudeSDKResultMessage['usage']>();
    expectTypeOf<MakaioSDKResultMessage['total_cost_usd']>().toEqualTypeOf<ClaudeSDKResultMessage['total_cost_usd']>();
    expectTypeOf<MakaioSDKResultMessage['num_turns']>().toEqualTypeOf<ClaudeSDKResultMessage['num_turns']>();
  });
});

// ---------------------------------------------------------------------------
// (D) Pattern: BetaMessage field access
//     Consumer does: msg.message.stop_reason, msg.message.model, msg.message.id
// ---------------------------------------------------------------------------

describe('Pattern D: BetaMessage field access on assistant messages', () => {
  it('stop_reason: our string|null is wider than Claude BetaStopReason|null', () => {
    // Claude uses a literal union; we use string. Claude values are assignable to ours.
    expectTypeOf<ClaudeSDKAssistantMessage['message']['stop_reason']>().toMatchTypeOf<
      MakaioSDKAssistantMessage['message']['stop_reason']
    >();
  });

  it('model is a required string on both sides (Claude uses Model type alias)', () => {
    // Claude's model is `Model` (string literal union with autocomplete); ours is `string`
    expectTypeOf<ClaudeSDKAssistantMessage['message']['model']>().toMatchTypeOf<
      MakaioSDKAssistantMessage['message']['model']
    >();
  });

  it('id is a string on both sides (Claude uses UUID template literal)', () => {
    expectTypeOf<ClaudeSDKAssistantMessage['message']['id']>().toMatchTypeOf<
      MakaioSDKAssistantMessage['message']['id']
    >();
  });

  it('role is "assistant" on both sides', () => {
    expectTypeOf<MakaioSDKAssistantMessage['message']['role']>().toEqualTypeOf<
      ClaudeSDKAssistantMessage['message']['role']
    >();
  });

  it('parent_tool_use_id is string | null on both sides', () => {
    expectTypeOf<MakaioSDKAssistantMessage['parent_tool_use_id']>().toEqualTypeOf<
      ClaudeSDKAssistantMessage['parent_tool_use_id']
    >();
  });
});
