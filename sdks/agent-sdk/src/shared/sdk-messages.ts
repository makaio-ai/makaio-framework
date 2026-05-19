// ---------------------------------------------------------------------------
// SDK Message Types (Claude Agent SDK-compatible shapes)
// ---------------------------------------------------------------------------

/**
 * UUID in RFC 4122 format (structurally equivalent to `crypto.UUID`).
 * Using a template literal avoids importing from the Node.js `crypto` module
 * while maintaining compatibility with the Claude Agent SDK UUID type.
 */
export type SDKUUID = `${string}-${string}-${string}-${string}-${string}`;

/** Discriminated union of all messages yielded by a query. */
export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKCompactBoundaryMessage
  | SDKToolResultMessage
  | SDKToolProgressMessage
  | SDKStatusMessage
  | SDKSessionStateChangedMessage;

/** BetaMessage-compatible subset for the assistant message payload. */
export interface SDKAssistantMessagePayload {
  readonly id: string;
  readonly type: 'message';
  readonly role: 'assistant';
  readonly model: string;
  readonly content: ContentBlock[];
  readonly stop_reason: string | null;
  readonly stop_sequence: string | null;
  readonly usage: SDKUsage;
}

export type SDKAssistantMessageError =
  | 'authentication_failed'
  | 'oauth_org_not_allowed'
  | 'billing_error'
  | 'rate_limit'
  | 'invalid_request'
  | 'server_error'
  | 'unknown'
  | 'max_output_tokens';

// ---------------------------------------------------------------------------
// SDKUsage helper sub-types (structurally mirror BetaUsage from
// @anthropic-ai/sdk so SDKUsage satisfies NonNullableUsage without a
// direct dependency on that package).
// ---------------------------------------------------------------------------

/**
 * Cache-creation token breakdown, mirroring BetaCacheCreation.
 */
export interface SDKCacheCreation {
  readonly ephemeral_1h_input_tokens: number;
  readonly ephemeral_5m_input_tokens: number;
}

/**
 * Server-tool request counts, mirroring BetaServerToolUsage.
 */
export interface SDKServerToolUsage {
  readonly web_fetch_requests: number;
  readonly web_search_requests: number;
}

/**
 * Common fields for all per-iteration usage records.
 */
interface SDKIterationUsageBase {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation: SDKCacheCreation | null;
}

/** Usage for a sampling iteration, mirroring BetaMessageIterationUsage. */
export interface SDKMessageIterationUsage extends SDKIterationUsageBase {
  readonly type: 'message';
}

/** Usage for a compaction iteration, mirroring BetaCompactionIterationUsage. */
export interface SDKCompactionIterationUsage extends SDKIterationUsageBase {
  readonly type: 'compaction';
}

/**
 * Usage for an advisor sub-inference iteration,
 * mirroring BetaAdvisorMessageIterationUsage.
 */
export interface SDKAdvisorIterationUsage extends SDKIterationUsageBase {
  readonly type: 'advisor_message';
  /** The model used for this advisor iteration. */
  readonly model: string;
}

/** Discriminated union of all per-iteration usage types. */
export type SDKIterationUsage = SDKMessageIterationUsage | SDKCompactionIterationUsage | SDKAdvisorIterationUsage;

export interface SDKAssistantMessage {
  readonly type: 'assistant';
  readonly message: SDKAssistantMessagePayload;
  readonly parent_tool_use_id: string | null;
  readonly error?: SDKAssistantMessageError;
  readonly uuid: string;
  readonly session_id: string;
}

/**
 * Individual content block types forming a discriminated union.
 * Structurally compatible with Anthropic BetaTextBlock / BetaThinkingBlock / BetaToolUseBlock.
 */
export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
  citations: TextCitation[] | null;
}

export interface ThinkingBlock {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly signature: string;
}

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** @see {@link https://docs.anthropic.com/en/docs/build-with-claude/citations} */
export interface TextCitation {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** Discriminated union of assistant content blocks (BetaContentBlock-compatible). */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;

/**
 * Makaio-specific message for tool execution results.
 * In the Claude SDK, tool results appear as user-role messages with tool_result
 * content blocks. Makaio emits them as a dedicated message type since the SDK
 * consumer doesn't construct the conversation history — the framework does.
 */
export interface SDKToolResultMessage {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error: boolean;
  readonly session_id: string;
  readonly uuid: string;
}

/**
 * Progress update emitted during long-running tool executions.
 * Mirrors the Claude Agent SDK `SDKToolProgressMessage` shape.
 */
export interface SDKToolProgressMessage {
  readonly type: 'tool_progress';
  readonly tool_use_id: string;
  readonly tool_name: string;
  readonly parent_tool_use_id: string | null;
  readonly elapsed_time_seconds: number;
  readonly task_id?: string;
  readonly uuid: string;
  readonly session_id: string;
}

/** Agent processing status, mirroring the Claude Agent SDK `SDKStatus`. */
export type SDKStatus = 'compacting' | 'requesting' | null;

/**
 * Status update for the agent processing pipeline.
 * Mirrors the Claude Agent SDK `SDKStatusMessage` shape.
 */
export interface SDKStatusMessage {
  readonly type: 'system';
  readonly subtype: 'status';
  readonly status: SDKStatus;
  readonly permissionMode?: PermissionMode;
  readonly compact_result?: 'success' | 'failed';
  readonly compact_error?: string;
  readonly uuid: string;
  readonly session_id: string;
}

/**
 * Session state transition notification.
 * Mirrors the Claude Agent SDK `SDKSessionStateChangedMessage` shape.
 */
export interface SDKSessionStateChangedMessage {
  readonly type: 'system';
  readonly subtype: 'session_state_changed';
  readonly state: 'idle' | 'running' | 'requires_action';
  readonly uuid: string;
  readonly session_id: string;
}

/**
 * Origin metadata describing where a user message came from.
 * Mirrors the Claude Agent SDK `SDKMessageOrigin` discriminated union.
 */
export type SDKMessageOrigin =
  | { kind: 'human' }
  | { kind: 'channel'; server: string }
  | { kind: 'peer'; from: string; name?: string }
  | { kind: 'task-notification' }
  | { kind: 'coordinator' };

export interface SDKUserMessage {
  readonly type: 'user';
  readonly message: {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
  };
  readonly parent_tool_use_id: string | null;
  readonly isSynthetic?: boolean;
  readonly tool_use_result?: unknown;
  readonly priority?: 'now' | 'next' | 'later';
  readonly origin?: SDKMessageOrigin;
  readonly shouldQuery?: boolean;
  readonly timestamp?: string;
  readonly uuid?: string;
  readonly session_id?: string;
}

/**
 * Per-model token and cost breakdown, mirroring the Claude Agent SDK
 * `ModelUsage` shape.
 */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly webSearchRequests: number;
  readonly costUSD: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/**
 * Tool-use denial record emitted when the agent is refused permission to call
 * a tool. Mirrors the Claude Agent SDK `SDKPermissionDenial` shape.
 */
export interface SDKPermissionDenial {
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly tool_input: Record<string, unknown>;
}

/**
 * Usage statistics for a single query, mirroring the Claude Agent SDK
 * `NonNullableUsage` shape (all fields of `BetaUsage` made non-nullable).
 */
export interface SDKUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation: SDKCacheCreation;
  readonly inference_geo: string;
  readonly iterations: SDKIterationUsage[];
  readonly server_tool_use: SDKServerToolUsage;
  readonly service_tier: 'standard' | 'priority' | 'batch';
  readonly speed: 'standard' | 'fast';
}

/**
 * Successful query result. Mirrors the Claude Agent SDK `SDKResultSuccess`
 * shape with the fields required by `@makaio/agent-sdk` consumers.
 */
export interface SDKResultSuccess {
  readonly type: 'result';
  readonly subtype: 'success';
  readonly duration_ms: number;
  readonly duration_api_ms: number;
  readonly is_error: boolean;
  readonly api_error_status?: number | null;
  readonly num_turns: number;
  readonly result: string;
  readonly stop_reason: string | null;
  readonly total_cost_usd: number;
  readonly usage: SDKUsage;
  readonly modelUsage: Record<string, ModelUsage>;
  readonly permission_denials: SDKPermissionDenial[];
  readonly session_id: string;
  readonly uuid: SDKUUID;
}

/**
 * Error query result. Mirrors the Claude Agent SDK `SDKResultError` shape.
 */
export interface SDKResultError {
  readonly type: 'result';
  readonly subtype:
    | 'error_during_execution'
    | 'error_max_turns'
    | 'error_max_budget_usd'
    | 'error_max_structured_output_retries';
  readonly duration_ms: number;
  readonly duration_api_ms: number;
  readonly is_error: boolean;
  readonly num_turns: number;
  readonly stop_reason: string | null;
  readonly total_cost_usd: number;
  readonly usage: SDKUsage;
  readonly modelUsage: Record<string, ModelUsage>;
  readonly permission_denials: SDKPermissionDenial[];
  readonly errors: string[];
  readonly session_id: string;
  readonly uuid: SDKUUID;
}

/** Discriminated union of successful and error query results. */
export type SDKResultMessage = SDKResultSuccess | SDKResultError;

// ---------------------------------------------------------------------------
// SDKSystemMessage helper enums (structurally mirror Claude Agent SDK)
// ---------------------------------------------------------------------------

/** API key provenance, mirroring the Claude Agent SDK `ApiKeySource`. */
export type ApiKeySource = 'user' | 'project' | 'org' | 'temporary' | 'oauth';

/** Permission mode, mirroring the Claude Agent SDK `PermissionMode`. */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

/** Fast-mode toggle state, mirroring the Claude Agent SDK `FastModeState`. */
export type FastModeState = 'off' | 'cooldown' | 'on';

export interface SDKSystemMessage {
  readonly type: 'system';
  readonly subtype: 'init';
  readonly apiKeySource: ApiKeySource;
  readonly claude_code_version: string;
  readonly cwd: string;
  readonly model: string;
  readonly tools: string[];
  readonly mcp_servers: { name: string; status: string }[];
  readonly permissionMode: PermissionMode;
  readonly slash_commands: string[];
  readonly output_style: string;
  readonly skills: string[];
  readonly plugins: { name: string; path: string }[];
  readonly agents?: string[];
  readonly betas?: string[];
  readonly fast_mode_state?: FastModeState;
  readonly session_id: string;
  readonly uuid: string;
}

export interface SDKCompactBoundaryMessage {
  readonly type: 'system';
  readonly subtype: 'compact_boundary';
  readonly compact_metadata: {
    readonly trigger: 'manual' | 'auto';
    readonly pre_tokens: number;
    readonly post_tokens?: number;
    readonly duration_ms?: number;
    readonly preserved_segment?: {
      readonly head_uuid: string;
      readonly anchor_uuid: string;
      readonly tail_uuid: string;
    };
  };
  readonly session_id: string;
  readonly uuid: string;
}
