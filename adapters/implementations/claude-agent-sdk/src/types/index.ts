import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SDKResultMessage } from '@makaio/client-claude-code';
import type { ClaudeCodeConnectorBus } from '../namespace/index.js';
import {
  AIReasoningLevel,
  BaseAgentConnectorConfig,
  ConnectorSessionConfig,
  MessageHandle,
  MessageResult,
} from '@makaio/ai-adapters-core';
import type { McpResolvedServer, McpRuntimeSessionContext, McpSessionContext, SystemPrompt } from '@makaio/contracts';

/**
 * Result returned after SDK stream consumption completes.
 *
 * `error` is present when stream consumption fails, while `lastResult` captures
 * the final SDK `result` message when available. `error` is optional and may
 * be `null`; `lastResult` is an `SDKResultMessage` or `null`.
 * @see SDKResultMessage
 */
export type ConsumptionCompleteResult = {
  error?: Error | null;
  lastResult: SDKResultMessage | null;
};

/**
 * Claude SDK query options used by this adapter.
 *
 * This aliases SDK `Options` while intentionally omitting `abortController`
 * because connector/session lifecycle owns cancellation.
 * @see Options
 */
export type ClaudeQueryOptions = Omit<Options, 'abortController'>;

/**
 * Claude Code-specific configuration options.
 *
 * These options are specific to the Claude Agent SDK and control
 * how the SDK processes messages and queries.
 */
export interface ClaudeSpecificConfig {
  /** SDK query options (excluding cwd/model which are handled at base level) */
  queryOptions?: Omit<ClaudeQueryOptions, 'cwd' | 'model'>;
  /** Use SDK immediate message mode for faster streaming responses */
  useSdkImmediateMessageMode?: boolean;
}

/**
 * Configuration for a Claude SDK connector session.
 *
 * Uses BaseAgentConnectorConfig with ClaudeSpecificConfig for provider-specific options.
 * Overrides the inherited `mcpSessionContext` so the adapter can access
 * `servers` for native-passthrough MCP configuration.
 */
export type ClaudeAgentConfig = Omit<
  BaseAgentConnectorConfig<ClaudeCodeConnectorBus, ClaudeSpecificConfig>,
  'mcpSessionContext'
> & {
  /** Adapter instance ID (required by AIAgentConnector) */
  adapterId: string;
  /**
   * MCP session context including upstream server configs.
   * Full host-resolved contexts support refresh; runtime contexts are enough
   * for SDK-provided dynamic server configuration.
   */
  mcpSessionContext?: McpRuntimeSessionContext | McpSessionContext;
  /**
   * Port of the in-process HTTP MCP server.
   * Populated from the `mcp.session.register` bus RPC response when the bridge
   * service is running; `undefined` when MCP is unavailable (graceful degradation).
   */
  mcpServerPort?: number;
  /**
   * Upstream MCP servers resolved from the session context.
   * Extracted from `mcpSessionContext.servers` by the adapter and injected into each SDK query.
   * The SDK manages transport and tool routing for these servers natively.
   */
  mcpUpstreamServers?: McpResolvedServer[];
};

/** Factory type for creating tool approval handlers */
export type CreateToolApprovalHandler = () => Options['canUseTool'];

/**
 * Callback type for emitting SDK events with connector metadata.
 */
export type EmitSdkEventCallback = (msg: unknown) => Promise<void>;

/**
 * Callback type for notifying when a turn starts processing a message.
 */
export type OnTurnStartCallback = (handle: MessageHandle) => void;

/**
 * Callback type for notifying when a turn completes with result.
 *
 * Promise-returning hooks are allowed for best-effort post-completion work,
 * but the session lifecycle does not await them before resolving the handle.
 */
export type OnTurnCompleteCallback = (handle: MessageHandle, result: MessageResult) => void | Promise<void>;

/**
 * Session configuration extending base with Claude-specific options.
 */
export interface ClaudeSessionConfig extends ConnectorSessionConfig<ClaudeCodeConnectorBus> {
  /** Makaio session ID for tool execution attribution and approval routing. */
  sessionId?: string;
  /**
   * Client identifier forwarded from the adapter definition (e.g. `'claude-code'`).
   * Used when emitting client.session.* observed-semantics events.
   */
  clientId?: string;
  reasoningEffort?: AIReasoningLevel;
  providerConfig?: ClaudeAgentConfig['providerConfig'];
  /** Runtime system prompt (set via start options) */
  systemPrompt?: SystemPrompt;
  /** Callback to emit SDK events through connector (for metadata injection) */
  emitSdkEvent?: EmitSdkEventCallback;
  /** Callback when turn starts processing a message (for pendingMessageHandle) */
  onTurnStart?: OnTurnStartCallback;
  /** Callback when turn completes (for lastResult) */
  onTurnComplete?: OnTurnCompleteCallback;
  /** Agent ID for event correlation */
  agentId: string;
  /** Previous adapter session ID for resume attempts. */
  resumeAdapterSessionId?: string;
  /** Predetermined session ID for new connectors (from swapConnector). Different from resume. */
  predeterminedSessionId?: string;
  /**
   * Port of the in-process HTTP MCP server.
   * Populated from the `mcp.session.register` bus RPC response; `undefined` when
   * the bridge service is not running (graceful degradation — no MCP for this session).
   */
  mcpServerPort?: number;
  /**
   * Upstream MCP servers resolved from the session context.
   * Baked into the SDK query at creation time so the SDK manages
   * transport and tool routing for each upstream server natively.
   */
  mcpUpstreamServers?: McpResolvedServer[];
}
