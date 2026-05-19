/**
 * Conformance: SDKSystemMessage must match the Claude Agent SDK shape.
 *
 * Claude SDK's SDKSystemMessage has many required fields that describe
 * the init state of a session. Our type mirrors these fields, providing
 * sensible defaults where bus data is unavailable.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { SDKSystemMessage as ClaudeSDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SDKSystemMessage } from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// 1. Discriminant fields — exact equality
// ---------------------------------------------------------------------------

describe('SDKSystemMessage discriminants', () => {
  it('type is "system"', () => {
    expectTypeOf<SDKSystemMessage['type']>().toEqualTypeOf<ClaudeSDKSystemMessage['type']>();
  });

  it('subtype is "init"', () => {
    expectTypeOf<SDKSystemMessage['subtype']>().toEqualTypeOf<ClaudeSDKSystemMessage['subtype']>();
  });
});

// ---------------------------------------------------------------------------
// 2. Required scalar fields — same types on both sides
// ---------------------------------------------------------------------------

describe('SDKSystemMessage required fields', () => {
  it('model is a required string', () => {
    expectTypeOf<SDKSystemMessage['model']>().toEqualTypeOf<ClaudeSDKSystemMessage['model']>();
  });

  it('cwd is a required string', () => {
    expectTypeOf<SDKSystemMessage['cwd']>().toEqualTypeOf<ClaudeSDKSystemMessage['cwd']>();
  });

  it('tools is a required string[]', () => {
    expectTypeOf<SDKSystemMessage['tools']>().toEqualTypeOf<ClaudeSDKSystemMessage['tools']>();
  });

  it('claude_code_version is a required string', () => {
    expectTypeOf<SDKSystemMessage['claude_code_version']>().toEqualTypeOf<
      ClaudeSDKSystemMessage['claude_code_version']
    >();
  });

  it('apiKeySource matches the ApiKeySource union', () => {
    expectTypeOf<SDKSystemMessage['apiKeySource']>().toEqualTypeOf<ClaudeSDKSystemMessage['apiKeySource']>();
  });

  it('permissionMode matches the PermissionMode union', () => {
    expectTypeOf<SDKSystemMessage['permissionMode']>().toEqualTypeOf<ClaudeSDKSystemMessage['permissionMode']>();
  });

  it('output_style is a required string', () => {
    expectTypeOf<SDKSystemMessage['output_style']>().toEqualTypeOf<ClaudeSDKSystemMessage['output_style']>();
  });

  it('session_id is a required string', () => {
    expectTypeOf<SDKSystemMessage['session_id']>().toEqualTypeOf<ClaudeSDKSystemMessage['session_id']>();
  });
});

// ---------------------------------------------------------------------------
// 3. Required array/object fields
// ---------------------------------------------------------------------------

describe('SDKSystemMessage required collection fields', () => {
  it('mcp_servers is a required array with name and status', () => {
    expectTypeOf<SDKSystemMessage['mcp_servers']>().toEqualTypeOf<ClaudeSDKSystemMessage['mcp_servers']>();
  });

  it('slash_commands is a required string[]', () => {
    expectTypeOf<SDKSystemMessage['slash_commands']>().toEqualTypeOf<ClaudeSDKSystemMessage['slash_commands']>();
  });

  it('skills is a required string[]', () => {
    expectTypeOf<SDKSystemMessage['skills']>().toEqualTypeOf<ClaudeSDKSystemMessage['skills']>();
  });

  it('plugins is a required array with name and path', () => {
    expectTypeOf<SDKSystemMessage['plugins']>().toEqualTypeOf<ClaudeSDKSystemMessage['plugins']>();
  });
});

// ---------------------------------------------------------------------------
// 4. Optional fields
// ---------------------------------------------------------------------------

describe('SDKSystemMessage optional fields', () => {
  it('agents is optional string[]', () => {
    expectTypeOf<SDKSystemMessage['agents']>().toEqualTypeOf<ClaudeSDKSystemMessage['agents']>();
  });

  it('betas is optional string[]', () => {
    expectTypeOf<SDKSystemMessage['betas']>().toEqualTypeOf<ClaudeSDKSystemMessage['betas']>();
  });

  it('fast_mode_state is optional FastModeState', () => {
    expectTypeOf<SDKSystemMessage['fast_mode_state']>().toEqualTypeOf<ClaudeSDKSystemMessage['fast_mode_state']>();
  });
});

// ---------------------------------------------------------------------------
// 5. Identifier compatibility — Claude UUID extends our string
// ---------------------------------------------------------------------------

describe('SDKSystemMessage identifier compatibility', () => {
  it('Claude uuid (UUID) extends Makaio uuid (string)', () => {
    expectTypeOf<ClaudeSDKSystemMessage['uuid']>().toMatchTypeOf<SDKSystemMessage['uuid']>();
  });
});
