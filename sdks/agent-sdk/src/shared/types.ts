import type { z } from 'zod/v3';
import type { TransportAuth } from '@makaio/bus-transport-websocket';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from '@makaio/contracts';
import type { SDKMessage, SDKUserMessage } from './sdk-messages.js';

// ---------------------------------------------------------------------------
// SDK Message Types — re-exported from sdk-messages.ts
// ---------------------------------------------------------------------------

export type {
  SDKUUID,
  SDKMessage,
  SDKAssistantMessagePayload,
  SDKAssistantMessageError,
  SDKCacheCreation,
  SDKServerToolUsage,
  SDKMessageIterationUsage,
  SDKCompactionIterationUsage,
  SDKAdvisorIterationUsage,
  SDKIterationUsage,
  SDKAssistantMessage,
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  TextCitation,
  ContentBlock,
  SDKToolResultMessage,
  SDKToolProgressMessage,
  SDKStatus,
  SDKStatusMessage,
  SDKSessionStateChangedMessage,
  SDKMessageOrigin,
  SDKUserMessage,
  ModelUsage,
  SDKPermissionDenial,
  SDKUsage,
  SDKResultSuccess,
  SDKResultError,
  SDKResultMessage,
  ApiKeySource,
  PermissionMode,
  FastModeState,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
} from './sdk-messages.js';

// ---------------------------------------------------------------------------
// Query API Types
// ---------------------------------------------------------------------------

export interface ModelInfo {
  readonly name: string;
  readonly friendlyName?: string;
  readonly contextWindowSize: number;
  readonly provider: string;
}

export interface AccountInfo {
  readonly provider: string;
  readonly email?: string;
}

export interface McpServerStatus {
  readonly name: string;
  readonly status: string;
}

export type McpSetServersResult = {
  added: string[];
  removed: string[];
  errors: Record<string, string>;
};

export interface SlashCommand {
  readonly name: string;
  readonly description: string;
}

/** Permission result returned by canUseTool callback. */
export type PermissionResult =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };

/**
 * Callback invoked when an agent requests permission to use a tool.
 * @param toolName - Requested tool name.
 * @param input - Tool input payload proposed by the agent.
 * @returns Permission decision, optionally asynchronously.
 */
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
) => PermissionResult | Promise<PermissionResult>;

/** Makaio-extended options for query(). */
export interface MakaioOptions {
  /** Canonical model name: "sonnet", "anthropic-sdk::sonnet", "openai-node::gpt-4o". */
  model: string;
  /** Working directory for the agent session. */
  cwd?: string;
  /** System prompt prepended to agent context. */
  systemPrompt?: string;
  /** Tool definitions created via tool(). */
  tools?: readonly MakaioToolDefinition[];
  /** Tool names the agent is allowed to use. */
  allowedTools?: string[];
  /** Tool names the agent is NOT allowed to use. */
  disallowedTools?: string[];
  /** Callback invoked when agent wants to use a tool. */
  canUseTool?: CanUseToolCallback;
  /** MCP server configurations. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Maximum number of turns before stopping. */
  maxTurns?: number;
  /** Environment variables for agent execution. */
  env?: Record<string, string>;
  /** AbortController for cancellation. */
  abortController?: AbortController;
  /** Whether to persist session to Makaio storage. */
  persistSession?: boolean;
  /** Resume an existing session by adapter session ID. */
  resume?: string;
  /** Attach to an existing Makaio session. */
  sessionId?: string;
  /** Reasoning effort level. */
  effort?: 'low' | 'medium' | 'high';
  /** JSON Schema for structured output. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, JsonValue> };

  // --- Makaio extensions (not in Claude SDK) ---

  /** WebSocket URL for /core mode. Ignored in /runtime mode. */
  websocketUrl?: string;
  /** WebSocket auth for /core mode. Auto-probed if omitted. */
  websocketAuth?: TransportAuth;
  /** Per-provider credentials override. */
  credentials?: Record<string, { apiKey?: string; [key: string]: string | undefined }>;
}

export type McpServerToolPolicy = {
  name: string;
  permission_policy: 'always_allow' | 'always_ask' | 'always_deny';
};

export type McpStdioServerConfig = {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
};

export type McpSSEServerConfig = {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[];
  alwaysLoad?: boolean;
};

export type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  tools?: McpServerToolPolicy[];
  alwaysLoad?: boolean;
};

/** MCP server configuration (Claude SDK-compatible). */
export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSdkServerConfigWithInstance;

/** MCP SDK server config with an in-process server instance. */
export type McpSdkServerConfig = {
  type: 'sdk';
  name: string;
};

/** Non-serializable MCP SDK server config containing a live server object. */
export type McpSdkServerConfigWithInstance = McpSdkServerConfig & {
  instance: McpServer;
};

/** Tool definition accepted by createSdkMcpServer(). */
export interface SdkMcpToolDefinition<Schema extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Schema;
  readonly annotations?: ToolAnnotations;
  readonly _meta?: Record<string, unknown>;
  readonly handler: (args: z.infer<z.ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>;
}

/** Options accepted by createSdkMcpServer(). */
export interface CreateSdkMcpServerOptions {
  readonly name: string;
  readonly version?: string;
  readonly tools?: readonly SdkMcpToolDefinition[];
  readonly alwaysLoad?: boolean;
}

/** Parameters for query(). */
export interface QueryParams {
  /** User prompt or async iterable for multi-turn. */
  prompt: string | AsyncIterable<SDKUserMessage>;
  /** Query options. */
  options?: MakaioOptions;
}

/** Parameters for startup(). */
export interface StartupParams {
  /** Options to configure the runtime (model not required). */
  options?: Omit<MakaioOptions, 'model'> & { model?: string };
}

/** A tool definition created by tool(). */
export interface MakaioToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly destructive?: boolean;
    readonly idempotent?: boolean;
    readonly requiresApproval?: boolean;
  };
}

/** Query control interface — AsyncGenerator with control methods. */
export interface MakaioQuery extends AsyncGenerator<SDKMessage, void> {
  /** Interrupt current processing. */
  interrupt(): Promise<void>;
  /** Change model mid-session (re-resolves canonical name). */
  setModel(model?: string): Promise<void>;
  /** Update max thinking tokens. */
  setMaxThinkingTokens(tokens: number | null): Promise<void>;
  /** Update MCP servers mid-session. */
  setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  /** List all supported models across providers. */
  supportedModels(): Promise<ModelInfo[]>;
  /** List supported slash commands (always empty for Makaio). */
  supportedCommands(): Promise<SlashCommand[]>;
  /** Get MCP server status. */
  mcpServerStatus(): Promise<McpServerStatus[]>;
  /** Get account info for the active provider. */
  accountInfo(): Promise<AccountInfo>;
  /** Close the query and release resources. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Session Management Types
// ---------------------------------------------------------------------------

export interface SDKSessionInfo {
  readonly sessionId: string;
  readonly title?: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly adapterName?: string;
}

export interface SessionMessage {
  readonly messageId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly timestamp: string;
}

export interface ListSessionsOptions {
  /** Filter by session status. */
  status?: 'active' | 'closed' | 'archived' | 'discovered' | 'all';
  /** Maximum number of sessions to return. */
  limit?: number;
}

export interface ForkSessionOptions {
  /** Message ID to fork from. */
  messageId?: string;
}

export interface ForkSessionResult {
  readonly sessionId: string;
}
