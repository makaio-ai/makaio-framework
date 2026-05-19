/**
 * Conformance: SDKCompactBoundaryMessage must match the Claude Agent SDK shape.
 *
 * Claude SDK uses subtype 'compact_boundary' with a compact_metadata payload.
 * Our type mirrors the same discriminants and payload structure. Because Claude
 * uses `UUID` (a crypto template-literal type) for identifier fields while we
 * use plain `string`, the compatibility checks follow the same directional
 * convention as the rest of the conformance suite: Claude's narrower UUID type
 * is verified to extend our wider string type (not the reverse).
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { SDKCompactBoundaryMessage as ClaudeSDKCompactBoundaryMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SDKCompactBoundaryMessage } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// 1. Discriminant fields — exact equality
// ---------------------------------------------------------------------------

describe('SDKCompactBoundaryMessage discriminants', () => {
  it('type is "system"', () => {
    expectTypeOf<SDKCompactBoundaryMessage['type']>().toEqualTypeOf<ClaudeSDKCompactBoundaryMessage['type']>();
  });

  it('subtype matches Claude SDK (compact_boundary)', () => {
    expectTypeOf<SDKCompactBoundaryMessage['subtype']>().toEqualTypeOf<ClaudeSDKCompactBoundaryMessage['subtype']>();
  });

  it('session_id is a string on both sides', () => {
    expectTypeOf<SDKCompactBoundaryMessage['session_id']>().toEqualTypeOf<
      ClaudeSDKCompactBoundaryMessage['session_id']
    >();
  });
});

// ---------------------------------------------------------------------------
// 2. Identifier fields — Claude UUID extends our string
// ---------------------------------------------------------------------------

describe('SDKCompactBoundaryMessage identifier compatibility', () => {
  it('Claude uuid (UUID) extends Makaio uuid (string)', () => {
    expectTypeOf<ClaudeSDKCompactBoundaryMessage['uuid']>().toMatchTypeOf<SDKCompactBoundaryMessage['uuid']>();
  });
});

// ---------------------------------------------------------------------------
// 3. compact_metadata payload — scalar fields match exactly
// ---------------------------------------------------------------------------

describe('SDKCompactBoundaryMessage.compact_metadata', () => {
  it('trigger covers the same union on both sides', () => {
    expectTypeOf<SDKCompactBoundaryMessage['compact_metadata']['trigger']>().toEqualTypeOf<
      ClaudeSDKCompactBoundaryMessage['compact_metadata']['trigger']
    >();
  });

  it('pre_tokens is a required number on both sides', () => {
    expectTypeOf<SDKCompactBoundaryMessage['compact_metadata']['pre_tokens']>().toEqualTypeOf<
      ClaudeSDKCompactBoundaryMessage['compact_metadata']['pre_tokens']
    >();
  });

  it('post_tokens is an optional number on both sides', () => {
    expectTypeOf<SDKCompactBoundaryMessage['compact_metadata']['post_tokens']>().toEqualTypeOf<
      ClaudeSDKCompactBoundaryMessage['compact_metadata']['post_tokens']
    >();
  });

  it('duration_ms is optional on both sides', () => {
    expectTypeOf<SDKCompactBoundaryMessage['compact_metadata']['duration_ms']>().toEqualTypeOf<
      ClaudeSDKCompactBoundaryMessage['compact_metadata']['duration_ms']
    >();
  });
});
