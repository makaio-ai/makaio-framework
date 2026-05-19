/**
 * Conformance tests: type-shape verification for the `\@makaio/agent-sdk` types.
 *
 * These tests verify that our SDK message types honour the structural
 * contracts they advertise — discriminant fields, required identifiers,
 * and union exhaustiveness — using compile-time assertions.
 *
 * Because bun:test does not provide vitest's `expectTypeOf`, this file uses
 * compile-time type-level assertions (`AssertEqual`, `AssertExtends`) that
 * cause a TypeScript error when the contract is violated. Each `it` block
 * contains a trivial `expect(true).toBe(true)` to satisfy the test runner;
 * the real verification happens at `tsc` time.
 *
 * The Claude Agent SDK (`\@anthropic-ai/claude-agent-sdk`) is an optional peer
 * dependency. When installed we additionally verify that the fields shared
 * between the two APIs carry the same structural shape. When absent the suite
 * degrades gracefully: all tests are skipped.
 */

import { describe, expect, it } from 'bun:test';
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
// Compile-time assertion helpers
// ---------------------------------------------------------------------------

/** Resolves to `true` when `A` and `B` are the exact same type. */
type IsEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Resolves to `true` when `A extends B`. */
type IsExtends<A, B> = A extends B ? true : false;

/** Compile-time assertion: fails to compile when `T` is not `true`. */
type AssertTrue<T extends true> = T;

/** Resolves to `true` when `T` has key `K`, otherwise `false`. */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

// Suppress unused-type warnings — these are consumed only via `type _` assertions.
type _Helpers = AssertTrue<true> | IsEqual<true, true> | IsExtends<true, true>;

// ---------------------------------------------------------------------------
// 1. Discriminant invariants
//    Every member of SDKMessage must carry a `type` field that narrows it
//    within the union.
// ---------------------------------------------------------------------------

describe('SDKMessage discriminant invariants', () => {
  it('SDKAssistantMessage.type is the literal "assistant"', () => {
    type _Check = AssertTrue<IsEqual<SDKAssistantMessage['type'], 'assistant'>>;
    expect(true).toBe(true);
  });

  it('SDKUserMessage.type is the literal "user"', () => {
    type _Check = AssertTrue<IsEqual<SDKUserMessage['type'], 'user'>>;
    expect(true).toBe(true);
  });

  it('SDKResultMessage.type is the literal "result"', () => {
    type _Check = AssertTrue<IsEqual<SDKResultMessage['type'], 'result'>>;
    expect(true).toBe(true);
  });

  it('SDKSystemMessage.type is the literal "system"', () => {
    type _Check = AssertTrue<IsEqual<SDKSystemMessage['type'], 'system'>>;
    expect(true).toBe(true);
  });

  it('SDKCompactBoundaryMessage.type is the literal "system"', () => {
    type _Check = AssertTrue<IsEqual<SDKCompactBoundaryMessage['type'], 'system'>>;
    expect(true).toBe(true);
  });

  it('SDKSystemMessage and SDKCompactBoundaryMessage are narrowed by subtype', () => {
    type _Check1 = AssertTrue<IsEqual<SDKSystemMessage['subtype'], 'init'>>;
    type _Check2 = AssertTrue<IsEqual<SDKCompactBoundaryMessage['subtype'], 'compact_boundary'>>;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Required identifier fields
//    session_id and uuid are required on messages where the bus always
//    provides them; they are optional on SDKUserMessage (user-originated).
// ---------------------------------------------------------------------------

describe('required identifier fields', () => {
  it('SDKAssistantMessage has required session_id and uuid', () => {
    type _Check1 = AssertTrue<IsEqual<SDKAssistantMessage['session_id'], string>>;
    type _Check2 = AssertTrue<IsEqual<SDKAssistantMessage['uuid'], string>>;
    expect(true).toBe(true);
  });

  it('SDKResultMessage has required session_id and uuid', () => {
    type _Check1 = AssertTrue<IsEqual<SDKResultMessage['session_id'], string>>;
    // uuid is a UUID template literal (`${string}-${string}-...`), a subtype of
    // string — use IsExtends to verify the string constraint holds.
    type _Check2 = AssertTrue<IsExtends<SDKResultMessage['uuid'], string>>;
    expect(true).toBe(true);
  });

  it('SDKSystemMessage has required session_id and uuid', () => {
    type _Check1 = AssertTrue<IsEqual<SDKSystemMessage['session_id'], string>>;
    type _Check2 = AssertTrue<IsEqual<SDKSystemMessage['uuid'], string>>;
    expect(true).toBe(true);
  });

  it('SDKCompactBoundaryMessage has required session_id and uuid', () => {
    type _Check1 = AssertTrue<IsEqual<SDKCompactBoundaryMessage['session_id'], string>>;
    type _Check2 = AssertTrue<IsEqual<SDKCompactBoundaryMessage['uuid'], string>>;
    expect(true).toBe(true);
  });

  it('SDKUserMessage has optional session_id and uuid', () => {
    type _Check1 = AssertTrue<IsEqual<HasKey<SDKUserMessage, 'session_id'>, true>>;
    type _Check2 = AssertTrue<IsEqual<HasKey<SDKUserMessage, 'uuid'>, true>>;
    type _Check3 = AssertTrue<IsEqual<SDKUserMessage['session_id'], string | undefined>>;
    type _Check4 = AssertTrue<IsEqual<SDKUserMessage['uuid'], string | undefined>>;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. SDKMessage union membership
//    All concrete message types are assignable to SDKMessage.
// ---------------------------------------------------------------------------

describe('SDKMessage union membership', () => {
  it('SDKAssistantMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKAssistantMessage, SDKMessage>>;
    expect(true).toBe(true);
  });

  it('SDKUserMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKUserMessage, SDKMessage>>;
    expect(true).toBe(true);
  });

  it('SDKResultMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKResultMessage, SDKMessage>>;
    expect(true).toBe(true);
  });

  it('SDKSystemMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKSystemMessage, SDKMessage>>;
    expect(true).toBe(true);
  });

  it('SDKCompactBoundaryMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKCompactBoundaryMessage, SDKMessage>>;
    expect(true).toBe(true);
  });

  it('SDKToolProgressMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKToolProgressMessage, SDKMessage>>;
    expect(true).toBe(true);
  });

  it('SDKStatusMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKStatusMessage, SDKMessage>>;
    expect(true).toBe(true);
  });

  it('SDKSessionStateChangedMessage is a member of SDKMessage', () => {
    type _Check = AssertTrue<IsExtends<SDKSessionStateChangedMessage, SDKMessage>>;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. ContentBlock structural invariants
// ---------------------------------------------------------------------------

describe('ContentBlock structural invariants', () => {
  it('has a type discriminant covering three variants', () => {
    type _Check = AssertTrue<IsEqual<ContentBlock['type'], 'text' | 'thinking' | 'tool_use'>>;
    expect(true).toBe(true);
  });

  it('narrows TextBlock with required text field', () => {
    type Narrowed = Extract<ContentBlock, { type: 'text' }>;
    type _Check = AssertTrue<IsEqual<Narrowed['text'], string>>;
    expect(true).toBe(true);
  });

  it('narrows ThinkingBlock with required thinking field', () => {
    type Narrowed = Extract<ContentBlock, { type: 'thinking' }>;
    type _Check = AssertTrue<IsEqual<Narrowed['thinking'], string>>;
    expect(true).toBe(true);
  });

  it('narrows ToolUseBlock with required id, name, and input', () => {
    type Narrowed = Extract<ContentBlock, { type: 'tool_use' }>;
    type _Check1 = AssertTrue<IsEqual<Narrowed['id'], string>>;
    type _Check2 = AssertTrue<IsEqual<Narrowed['name'], string>>;
    type _Check3 = AssertTrue<IsEqual<Narrowed['input'], Record<string, unknown>>>;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. SDKUsage field types
// ---------------------------------------------------------------------------

describe('SDKUsage field types', () => {
  it('all token counters are numbers', () => {
    type _Check1 = AssertTrue<IsEqual<SDKUsage['input_tokens'], number>>;
    type _Check2 = AssertTrue<IsEqual<SDKUsage['output_tokens'], number>>;
    type _Check3 = AssertTrue<IsEqual<SDKUsage['cache_read_input_tokens'], number>>;
    type _Check4 = AssertTrue<IsEqual<SDKUsage['cache_creation_input_tokens'], number>>;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. SDKResultMessage subtype exhaustiveness
// ---------------------------------------------------------------------------

describe('SDKResultMessage subtype', () => {
  it('subtype covers success and all error variants', () => {
    type _Check = AssertTrue<
      IsEqual<
        SDKResultMessage['subtype'],
        | 'success'
        | 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries'
      >
    >;
    expect(true).toBe(true);
  });

  it('is_error is a boolean', () => {
    type _Check = AssertTrue<IsEqual<SDKResultMessage['is_error'], boolean>>;
    expect(true).toBe(true);
  });

  it('duration_ms, num_turns, total_cost_usd are numbers', () => {
    type _Check1 = AssertTrue<IsEqual<SDKResultMessage['duration_ms'], number>>;
    type _Check2 = AssertTrue<IsEqual<SDKResultMessage['num_turns'], number>>;
    type _Check3 = AssertTrue<IsEqual<SDKResultMessage['total_cost_usd'], number>>;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. SDKCompactBoundaryMessage compact_metadata field
// ---------------------------------------------------------------------------

describe('SDKCompactBoundaryMessage compact_metadata', () => {
  it('subtype is the literal "compact_boundary"', () => {
    type _Check = AssertTrue<IsEqual<SDKCompactBoundaryMessage['subtype'], 'compact_boundary'>>;
    expect(true).toBe(true);
  });

  it('compact_metadata.trigger covers "manual" and "auto"', () => {
    type _Check = AssertTrue<IsEqual<SDKCompactBoundaryMessage['compact_metadata']['trigger'], 'manual' | 'auto'>>;
    expect(true).toBe(true);
  });

  it('compact_metadata.pre_tokens is a required number', () => {
    type _Check = AssertTrue<IsEqual<SDKCompactBoundaryMessage['compact_metadata']['pre_tokens'], number>>;
    expect(true).toBe(true);
  });

  it('compact_metadata.post_tokens is an optional number', () => {
    type _Check = AssertTrue<IsEqual<SDKCompactBoundaryMessage['compact_metadata']['post_tokens'], number | undefined>>;
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. MakaioQuery extends AsyncGenerator<SDKMessage>
// ---------------------------------------------------------------------------

describe('MakaioQuery extends AsyncGenerator<SDKMessage>', () => {
  it('MakaioQuery is assignable to AsyncGenerator<SDKMessage, void>', () => {
    type _Check = AssertTrue<IsExtends<MakaioQuery, AsyncGenerator<SDKMessage, void>>>;
    expect(true).toBe(true);
  });

  it('MakaioQuery has interrupt() returning Promise<void>', () => {
    type _Check = AssertTrue<IsEqual<MakaioQuery['interrupt'], () => Promise<void>>>;
    expect(true).toBe(true);
  });

  it('MakaioQuery has close() returning void', () => {
    type _Check = AssertTrue<IsEqual<MakaioQuery['close'], () => void>>;
    expect(true).toBe(true);
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
    type _Check = AssertTrue<IsEqual<ReturnType<typeof coreQuery>, MakaioQuery>>;
    expect(true).toBe(true);
  });

  it('/runtime query() returns MakaioQuery synchronously', () => {
    type _Check = AssertTrue<IsEqual<ReturnType<typeof runtimeQuery>, MakaioQuery>>;
    expect(true).toBe(true);
  });

  it('MakaioQuery exposes the shared Claude Query control surface', () => {
    type _Check1 = AssertTrue<IsEqual<MakaioQuery['interrupt'], ClaudeQuery['interrupt']>>;
    type _Check2 = AssertTrue<IsEqual<MakaioQuery['setModel'], ClaudeQuery['setModel']>>;
    type _Check3 = AssertTrue<IsEqual<MakaioQuery['setMaxThinkingTokens'], ClaudeQuery['setMaxThinkingTokens']>>;
    type _Check4 = AssertTrue<IsEqual<McpSetServersResult, ClaudeMcpSetServersResult>>;
    type _Check5 = AssertTrue<IsEqual<MakaioQuery['close'], ClaudeQuery['close']>>;
    expect(true).toBe(true);
  });

  it('SDK MCP server configs mirror Claude live-instance config fields', () => {
    type _Check1 = AssertTrue<
      IsEqual<McpSdkServerConfigWithInstance['type'], ClaudeMcpSdkServerConfigWithInstance['type']>
    >;
    type _Check2 = AssertTrue<
      IsEqual<McpSdkServerConfigWithInstance['name'], ClaudeMcpSdkServerConfigWithInstance['name']>
    >;
    type _Check3 = AssertTrue<
      IsExtends<keyof McpSdkServerConfigWithInstance, keyof ClaudeMcpSdkServerConfigWithInstance>
    >;
    expect(true).toBe(true);
  });

  it('SDK MCP tool definitions mirror Claude public fields without deep Zod expansion', () => {
    type _Check1 = AssertTrue<IsEqual<SdkMcpToolDefinition['name'], ClaudeSdkMcpToolDefinition['name']>>;
    type _Check2 = AssertTrue<IsEqual<SdkMcpToolDefinition['description'], ClaudeSdkMcpToolDefinition['description']>>;
    type _Check3 = AssertTrue<IsEqual<SdkMcpToolDefinition['annotations'], ClaudeSdkMcpToolDefinition['annotations']>>;
    type _Check4 = AssertTrue<IsEqual<SdkMcpToolDefinition['_meta'], ClaudeSdkMcpToolDefinition['_meta']>>;
    expect(true).toBe(true);
  });

  it('assistant messages mirror Claude discriminants and identifiers', () => {
    type _Check1 = AssertTrue<IsEqual<SDKAssistantMessage['type'], ClaudeSDKAssistantMessage['type']>>;
    type _Check2 = AssertTrue<
      IsEqual<SDKAssistantMessage['message']['role'], ClaudeSDKAssistantMessage['message']['role']>
    >;
    type _Check3 = AssertTrue<IsExtends<ClaudeSDKAssistantMessage['uuid'], SDKAssistantMessage['uuid']>>;
    type _Check4 = AssertTrue<IsEqual<SDKAssistantMessage['session_id'], ClaudeSDKAssistantMessage['session_id']>>;
    expect(true).toBe(true);
  });

  it('user messages mirror Claude discriminants and optional identifiers', () => {
    type _Check1 = AssertTrue<IsEqual<SDKUserMessage['type'], ClaudeSDKUserMessage['type']>>;
    type _Check2 = AssertTrue<IsExtends<SDKUserMessage['message']['role'], ClaudeSDKUserMessage['message']['role']>>;
    type _Check3 = AssertTrue<IsExtends<ClaudeSDKUserMessage['uuid'], SDKUserMessage['uuid']>>;
    type _Check4 = AssertTrue<IsExtends<ClaudeSDKUserMessage['session_id'], SDKUserMessage['session_id']>>;
    expect(true).toBe(true);
  });

  it('result messages mirror Claude scalar metadata fields', () => {
    type _Check1 = AssertTrue<IsEqual<SDKResultMessage['type'], ClaudeSDKResultMessage['type']>>;
    type _Check2 = AssertTrue<IsEqual<SDKResultMessage['duration_ms'], ClaudeSDKResultMessage['duration_ms']>>;
    type _Check3 = AssertTrue<IsEqual<SDKResultMessage['is_error'], ClaudeSDKResultMessage['is_error']>>;
    type _Check4 = AssertTrue<IsEqual<SDKResultMessage['num_turns'], ClaudeSDKResultMessage['num_turns']>>;
    type _Check5 = AssertTrue<IsEqual<SDKResultMessage['total_cost_usd'], ClaudeSDKResultMessage['total_cost_usd']>>;
    type _Check6 = AssertTrue<IsExtends<ClaudeSDKResultMessage['uuid'], SDKResultMessage['uuid']>>;
    type _Check7 = AssertTrue<IsEqual<SDKResultMessage['session_id'], ClaudeSDKResultMessage['session_id']>>;
    expect(true).toBe(true);
  });

  it('system init messages mirror Claude init fields', () => {
    type _Check1 = AssertTrue<IsEqual<SDKSystemMessage['type'], ClaudeSDKSystemMessage['type']>>;
    type _Check2 = AssertTrue<IsEqual<SDKSystemMessage['subtype'], ClaudeSDKSystemMessage['subtype']>>;
    type _Check3 = AssertTrue<IsEqual<SDKSystemMessage['model'], ClaudeSDKSystemMessage['model']>>;
    type _Check4 = AssertTrue<IsEqual<SDKSystemMessage['cwd'], ClaudeSDKSystemMessage['cwd']>>;
    type _Check5 = AssertTrue<IsEqual<SDKSystemMessage['tools'], ClaudeSDKSystemMessage['tools']>>;
    type _Check6 = AssertTrue<IsEqual<SDKSystemMessage['apiKeySource'], ClaudeSDKSystemMessage['apiKeySource']>>;
    type _Check7 = AssertTrue<
      IsEqual<SDKSystemMessage['claude_code_version'], ClaudeSDKSystemMessage['claude_code_version']>
    >;
    type _Check8 = AssertTrue<IsEqual<SDKSystemMessage['permissionMode'], ClaudeSDKSystemMessage['permissionMode']>>;
    type _Check9 = AssertTrue<IsEqual<SDKSystemMessage['output_style'], ClaudeSDKSystemMessage['output_style']>>;
    type _Check10 = AssertTrue<IsEqual<SDKSystemMessage['mcp_servers'], ClaudeSDKSystemMessage['mcp_servers']>>;
    type _Check11 = AssertTrue<IsEqual<SDKSystemMessage['slash_commands'], ClaudeSDKSystemMessage['slash_commands']>>;
    type _Check12 = AssertTrue<IsEqual<SDKSystemMessage['skills'], ClaudeSDKSystemMessage['skills']>>;
    type _Check13 = AssertTrue<IsEqual<SDKSystemMessage['plugins'], ClaudeSDKSystemMessage['plugins']>>;
    type _Check14 = AssertTrue<IsExtends<ClaudeSDKSystemMessage['uuid'], SDKSystemMessage['uuid']>>;
    type _Check15 = AssertTrue<IsEqual<SDKSystemMessage['session_id'], ClaudeSDKSystemMessage['session_id']>>;
    expect(true).toBe(true);
  });
});
