/**
 * Conformance tests: type-shape verification for the `\@makaio/agent-sdk` types.
 *
 * These tests verify that our SDK message types honour the structural
 * contracts they advertise — discriminant fields, required identifiers,
 * and union exhaustiveness — using compile-time assertions via vitest's
 * `expectTypeOf`.
 *
 * The Claude Agent SDK (`\@anthropic-ai/claude-agent-sdk`) is an optional peer
 * dependency. When installed we additionally verify that the fields shared
 * between the two APIs carry the same structural shape. When absent the suite
 * degrades gracefully: all tests are skipped.
 */

import { describe, expectTypeOf, it } from 'vitest';
import type {
  Query as ClaudeQuery,
  McpSdkServerConfigWithInstance as ClaudeMcpSdkServerConfigWithInstance,
  McpSetServersResult as ClaudeMcpSetServersResult,
  SDKAssistantMessage as ClaudeSDKAssistantMessage,
  SDKResultMessage as ClaudeSDKResultMessage,
  SDKSystemMessage as ClaudeSDKSystemMessage,
  SDKUserMessage as ClaudeSDKUserMessage,
  SdkMcpToolDefinition as ClaudeSdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import type { query as coreQuery } from '../../src/core/index.js';
import type { query as runtimeQuery } from '../../src/runtime/index.js';
import type {
  ContentBlock,
  McpSdkServerConfigWithInstance,
  McpSetServersResult,
  MakaioQuery,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKStatusMessage,
  SDKSystemMessage,
  SDKToolProgressMessage,
  SDKUsage,
  SDKUserMessage,
  SdkMcpToolDefinition,
} from '../../src/shared/types.js';

// ---------------------------------------------------------------------------
// Utility types used in assertions
// ---------------------------------------------------------------------------

/** Resolves to `true` when `T` has key `K`, otherwise `false`. */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

// ---------------------------------------------------------------------------
// 1. Discriminant invariants
//    Every member of SDKMessage must carry a `type` field that narrows it
//    within the union.
// ---------------------------------------------------------------------------

describe('SDKMessage discriminant invariants', () => {
  it('SDKAssistantMessage.type is the literal "assistant"', () => {
    expectTypeOf<SDKAssistantMessage['type']>().toEqualTypeOf<'assistant'>();
  });

  it('SDKUserMessage.type is the literal "user"', () => {
    expectTypeOf<SDKUserMessage['type']>().toEqualTypeOf<'user'>();
  });

  it('SDKResultMessage.type is the literal "result"', () => {
    expectTypeOf<SDKResultMessage['type']>().toEqualTypeOf<'result'>();
  });

  it('SDKSystemMessage.type is the literal "system"', () => {
    expectTypeOf<SDKSystemMessage['type']>().toEqualTypeOf<'system'>();
  });

  it('SDKCompactBoundaryMessage.type is the literal "system"', () => {
    expectTypeOf<SDKCompactBoundaryMessage['type']>().toEqualTypeOf<'system'>();
  });

  it('SDKSystemMessage and SDKCompactBoundaryMessage are narrowed by subtype', () => {
    expectTypeOf<SDKSystemMessage['subtype']>().toEqualTypeOf<'init'>();
    expectTypeOf<SDKCompactBoundaryMessage['subtype']>().toEqualTypeOf<'compact_boundary'>();
  });
});

// ---------------------------------------------------------------------------
// 2. Required identifier fields
//    session_id and uuid are required on messages where the bus always
//    provides them; they are optional on SDKUserMessage (user-originated).
// ---------------------------------------------------------------------------

describe('required identifier fields', () => {
  it('SDKAssistantMessage has required session_id and uuid', () => {
    expectTypeOf<SDKAssistantMessage['session_id']>().toEqualTypeOf<string>();
    expectTypeOf<SDKAssistantMessage['uuid']>().toEqualTypeOf<string>();
  });

  it('SDKResultMessage has required session_id and uuid', () => {
    expectTypeOf<SDKResultMessage['session_id']>().toEqualTypeOf<string>();
    // uuid is a UUID template literal (`${string}-${string}-...`), a subtype of
    // string — use toMatchTypeOf to verify the string constraint holds.
    expectTypeOf<SDKResultMessage['uuid']>().toMatchTypeOf<string>();
  });

  it('SDKSystemMessage has required session_id and uuid', () => {
    expectTypeOf<SDKSystemMessage['session_id']>().toEqualTypeOf<string>();
    expectTypeOf<SDKSystemMessage['uuid']>().toEqualTypeOf<string>();
  });

  it('SDKCompactBoundaryMessage has required session_id and uuid', () => {
    expectTypeOf<SDKCompactBoundaryMessage['session_id']>().toEqualTypeOf<string>();
    expectTypeOf<SDKCompactBoundaryMessage['uuid']>().toEqualTypeOf<string>();
  });

  it('SDKUserMessage has optional session_id and uuid', () => {
    expectTypeOf<HasKey<SDKUserMessage, 'session_id'>>().toEqualTypeOf<true>();
    expectTypeOf<HasKey<SDKUserMessage, 'uuid'>>().toEqualTypeOf<true>();
    expectTypeOf<SDKUserMessage['session_id']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<SDKUserMessage['uuid']>().toEqualTypeOf<string | undefined>();
  });
});

// ---------------------------------------------------------------------------
// 3. SDKMessage union membership
//    All concrete message types are assignable to SDKMessage.
// ---------------------------------------------------------------------------

describe('SDKMessage union membership', () => {
  it('SDKAssistantMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKAssistantMessage>().toMatchTypeOf<SDKMessage>();
  });

  it('SDKUserMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKUserMessage>().toMatchTypeOf<SDKMessage>();
  });

  it('SDKResultMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKResultMessage>().toMatchTypeOf<SDKMessage>();
  });

  it('SDKSystemMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKSystemMessage>().toMatchTypeOf<SDKMessage>();
  });

  it('SDKCompactBoundaryMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKCompactBoundaryMessage>().toMatchTypeOf<SDKMessage>();
  });

  it('SDKToolProgressMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKToolProgressMessage>().toMatchTypeOf<SDKMessage>();
  });

  it('SDKStatusMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKStatusMessage>().toMatchTypeOf<SDKMessage>();
  });

  it('SDKSessionStateChangedMessage is a member of SDKMessage', () => {
    expectTypeOf<SDKSessionStateChangedMessage>().toMatchTypeOf<SDKMessage>();
  });
});

// ---------------------------------------------------------------------------
// 4. ContentBlock structural invariants
// ---------------------------------------------------------------------------

describe('ContentBlock structural invariants', () => {
  it('has a type discriminant covering three variants', () => {
    expectTypeOf<ContentBlock['type']>().toEqualTypeOf<'text' | 'thinking' | 'tool_use'>();
  });

  it('narrows TextBlock with required text field', () => {
    type Narrowed = Extract<ContentBlock, { type: 'text' }>;
    expectTypeOf<Narrowed['text']>().toEqualTypeOf<string>();
  });

  it('narrows ThinkingBlock with required thinking field', () => {
    type Narrowed = Extract<ContentBlock, { type: 'thinking' }>;
    expectTypeOf<Narrowed['thinking']>().toEqualTypeOf<string>();
  });

  it('narrows ToolUseBlock with required id, name, and input', () => {
    type Narrowed = Extract<ContentBlock, { type: 'tool_use' }>;
    expectTypeOf<Narrowed['id']>().toEqualTypeOf<string>();
    expectTypeOf<Narrowed['name']>().toEqualTypeOf<string>();
    expectTypeOf<Narrowed['input']>().toEqualTypeOf<Record<string, unknown>>();
  });
});

// ---------------------------------------------------------------------------
// 5. SDKUsage field types
// ---------------------------------------------------------------------------

describe('SDKUsage field types', () => {
  it('all token counters are numbers', () => {
    expectTypeOf<SDKUsage['input_tokens']>().toEqualTypeOf<number>();
    expectTypeOf<SDKUsage['output_tokens']>().toEqualTypeOf<number>();
    expectTypeOf<SDKUsage['cache_read_input_tokens']>().toEqualTypeOf<number>();
    expectTypeOf<SDKUsage['cache_creation_input_tokens']>().toEqualTypeOf<number>();
  });
});

// ---------------------------------------------------------------------------
// 6. SDKResultMessage subtype exhaustiveness
// ---------------------------------------------------------------------------

describe('SDKResultMessage subtype', () => {
  it('subtype covers success and all error variants', () => {
    expectTypeOf<SDKResultMessage['subtype']>().toEqualTypeOf<
      | 'success'
      | 'error_during_execution'
      | 'error_max_turns'
      | 'error_max_budget_usd'
      | 'error_max_structured_output_retries'
    >();
  });

  it('is_error is a boolean', () => {
    expectTypeOf<SDKResultMessage['is_error']>().toEqualTypeOf<boolean>();
  });

  it('duration_ms, num_turns, total_cost_usd are numbers', () => {
    expectTypeOf<SDKResultMessage['duration_ms']>().toEqualTypeOf<number>();
    expectTypeOf<SDKResultMessage['num_turns']>().toEqualTypeOf<number>();
    expectTypeOf<SDKResultMessage['total_cost_usd']>().toEqualTypeOf<number>();
  });
});

// ---------------------------------------------------------------------------
// 7. SDKCompactBoundaryMessage compact_metadata field
// ---------------------------------------------------------------------------

describe('SDKCompactBoundaryMessage compact_metadata', () => {
  it('subtype is the literal "compact_boundary"', () => {
    expectTypeOf<SDKCompactBoundaryMessage['subtype']>().toEqualTypeOf<'compact_boundary'>();
  });

  it('compact_metadata.trigger covers "manual" and "auto"', () => {
    expectTypeOf<SDKCompactBoundaryMessage['compact_metadata']['trigger']>().toEqualTypeOf<'manual' | 'auto'>();
  });

  it('compact_metadata.pre_tokens is a required number', () => {
    expectTypeOf<SDKCompactBoundaryMessage['compact_metadata']['pre_tokens']>().toEqualTypeOf<number>();
  });

  it('compact_metadata.post_tokens is an optional number', () => {
    expectTypeOf<SDKCompactBoundaryMessage['compact_metadata']['post_tokens']>().toEqualTypeOf<number | undefined>();
  });
});

// ---------------------------------------------------------------------------
// 8. MakaioQuery extends AsyncGenerator<SDKMessage>
// ---------------------------------------------------------------------------

describe('MakaioQuery extends AsyncGenerator<SDKMessage>', () => {
  it('MakaioQuery is assignable to AsyncGenerator<SDKMessage, void>', () => {
    expectTypeOf<MakaioQuery>().toMatchTypeOf<AsyncGenerator<SDKMessage, void>>();
  });

  it('MakaioQuery has interrupt() returning Promise<void>', () => {
    expectTypeOf<MakaioQuery['interrupt']>().toEqualTypeOf<() => Promise<void>>();
  });

  it('MakaioQuery has close() returning void', () => {
    expectTypeOf<MakaioQuery['close']>().toEqualTypeOf<() => void>();
  });
});

// ---------------------------------------------------------------------------
// 9. Claude SDK cross-reference checks
//
//    These assertions import the Claude SDK public types directly. They avoid
//    self-referential checks by proving Makaio's public query and message types
//    are assignable to the Claude-compatible subset we intentionally mirror.
// ---------------------------------------------------------------------------

describe('Claude SDK cross-reference (public type compatibility)', () => {
  it('/core query() returns MakaioQuery synchronously', () => {
    expectTypeOf<ReturnType<typeof coreQuery>>().toEqualTypeOf<MakaioQuery>();
  });

  it('/runtime query() returns MakaioQuery synchronously', () => {
    expectTypeOf<ReturnType<typeof runtimeQuery>>().toEqualTypeOf<MakaioQuery>();
  });

  it('MakaioQuery exposes the shared Claude Query control surface', () => {
    expectTypeOf<MakaioQuery['interrupt']>().toEqualTypeOf<ClaudeQuery['interrupt']>();
    expectTypeOf<MakaioQuery['setModel']>().toEqualTypeOf<ClaudeQuery['setModel']>();
    expectTypeOf<MakaioQuery['setMaxThinkingTokens']>().toEqualTypeOf<ClaudeQuery['setMaxThinkingTokens']>();
    expectTypeOf<McpSetServersResult>().toEqualTypeOf<ClaudeMcpSetServersResult>();
    expectTypeOf<MakaioQuery['close']>().toEqualTypeOf<ClaudeQuery['close']>();
  });

  it('SDK MCP server configs mirror Claude live-instance config fields', () => {
    expectTypeOf<McpSdkServerConfigWithInstance['type']>().toEqualTypeOf<
      ClaudeMcpSdkServerConfigWithInstance['type']
    >();
    expectTypeOf<McpSdkServerConfigWithInstance['name']>().toEqualTypeOf<
      ClaudeMcpSdkServerConfigWithInstance['name']
    >();
    expectTypeOf<keyof McpSdkServerConfigWithInstance>().toMatchTypeOf<keyof ClaudeMcpSdkServerConfigWithInstance>();
  });

  it('SDK MCP tool definitions mirror Claude public fields without deep Zod expansion', () => {
    expectTypeOf<SdkMcpToolDefinition['name']>().toEqualTypeOf<ClaudeSdkMcpToolDefinition['name']>();
    expectTypeOf<SdkMcpToolDefinition['description']>().toEqualTypeOf<ClaudeSdkMcpToolDefinition['description']>();
    expectTypeOf<SdkMcpToolDefinition['annotations']>().toEqualTypeOf<ClaudeSdkMcpToolDefinition['annotations']>();
    expectTypeOf<SdkMcpToolDefinition['_meta']>().toEqualTypeOf<ClaudeSdkMcpToolDefinition['_meta']>();
  });

  it('assistant messages mirror Claude discriminants and identifiers', () => {
    expectTypeOf<SDKAssistantMessage['type']>().toEqualTypeOf<ClaudeSDKAssistantMessage['type']>();
    expectTypeOf<SDKAssistantMessage['message']['role']>().toEqualTypeOf<
      ClaudeSDKAssistantMessage['message']['role']
    >();
    expectTypeOf<ClaudeSDKAssistantMessage['uuid']>().toMatchTypeOf<SDKAssistantMessage['uuid']>();
    expectTypeOf<SDKAssistantMessage['session_id']>().toEqualTypeOf<ClaudeSDKAssistantMessage['session_id']>();
  });

  it('user messages mirror Claude discriminants and optional identifiers', () => {
    expectTypeOf<SDKUserMessage['type']>().toEqualTypeOf<ClaudeSDKUserMessage['type']>();
    expectTypeOf<SDKUserMessage['message']['role']>().toMatchTypeOf<ClaudeSDKUserMessage['message']['role']>();
    expectTypeOf<ClaudeSDKUserMessage['uuid']>().toMatchTypeOf<SDKUserMessage['uuid']>();
    expectTypeOf<ClaudeSDKUserMessage['session_id']>().toMatchTypeOf<SDKUserMessage['session_id']>();
  });

  it('result messages mirror Claude scalar metadata fields', () => {
    expectTypeOf<SDKResultMessage['type']>().toEqualTypeOf<ClaudeSDKResultMessage['type']>();
    expectTypeOf<SDKResultMessage['duration_ms']>().toEqualTypeOf<ClaudeSDKResultMessage['duration_ms']>();
    expectTypeOf<SDKResultMessage['is_error']>().toEqualTypeOf<ClaudeSDKResultMessage['is_error']>();
    expectTypeOf<SDKResultMessage['num_turns']>().toEqualTypeOf<ClaudeSDKResultMessage['num_turns']>();
    expectTypeOf<SDKResultMessage['total_cost_usd']>().toEqualTypeOf<ClaudeSDKResultMessage['total_cost_usd']>();
    expectTypeOf<ClaudeSDKResultMessage['uuid']>().toMatchTypeOf<SDKResultMessage['uuid']>();
    expectTypeOf<SDKResultMessage['session_id']>().toEqualTypeOf<ClaudeSDKResultMessage['session_id']>();
  });

  it('system init messages mirror Claude init fields', () => {
    expectTypeOf<SDKSystemMessage['type']>().toEqualTypeOf<ClaudeSDKSystemMessage['type']>();
    expectTypeOf<SDKSystemMessage['subtype']>().toEqualTypeOf<ClaudeSDKSystemMessage['subtype']>();
    expectTypeOf<SDKSystemMessage['model']>().toEqualTypeOf<ClaudeSDKSystemMessage['model']>();
    expectTypeOf<SDKSystemMessage['cwd']>().toEqualTypeOf<ClaudeSDKSystemMessage['cwd']>();
    expectTypeOf<SDKSystemMessage['tools']>().toEqualTypeOf<ClaudeSDKSystemMessage['tools']>();
    expectTypeOf<SDKSystemMessage['apiKeySource']>().toEqualTypeOf<ClaudeSDKSystemMessage['apiKeySource']>();
    expectTypeOf<SDKSystemMessage['claude_code_version']>().toEqualTypeOf<
      ClaudeSDKSystemMessage['claude_code_version']
    >();
    expectTypeOf<SDKSystemMessage['permissionMode']>().toEqualTypeOf<ClaudeSDKSystemMessage['permissionMode']>();
    expectTypeOf<SDKSystemMessage['output_style']>().toEqualTypeOf<ClaudeSDKSystemMessage['output_style']>();
    expectTypeOf<SDKSystemMessage['mcp_servers']>().toEqualTypeOf<ClaudeSDKSystemMessage['mcp_servers']>();
    expectTypeOf<SDKSystemMessage['slash_commands']>().toEqualTypeOf<ClaudeSDKSystemMessage['slash_commands']>();
    expectTypeOf<SDKSystemMessage['skills']>().toEqualTypeOf<ClaudeSDKSystemMessage['skills']>();
    expectTypeOf<SDKSystemMessage['plugins']>().toEqualTypeOf<ClaudeSDKSystemMessage['plugins']>();
    expectTypeOf<ClaudeSDKSystemMessage['uuid']>().toMatchTypeOf<SDKSystemMessage['uuid']>();
    expectTypeOf<SDKSystemMessage['session_id']>().toEqualTypeOf<ClaudeSDKSystemMessage['session_id']>();
  });
});
