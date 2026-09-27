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
import type {
  McpResolvedServer,
  McpRuntimeSessionContext,
  McpSessionContext,
  NativeForkDirective,
  ResolvedToolPolicy,
  SystemPrompt,
} from '@makaio/contracts';

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
  /**
   * Native fork directive from the session orchestrator.
   * Forwarded from the agent config into the connector so the session can use
   * the provider's branching API instead of replaying history.
   */
  nativeFork?: NativeForkDirective;
};

/**
 * Factory type for creating tool approval handlers.
 * @param policy - Caller tool policy resolved once for the query being built.
 */
export type CreateToolApprovalHandler = (policy: ResolvedToolPolicy) => Options['canUseTool'];

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
   * Native fork directive from the session orchestrator.
   *
   * When set, the initial query uses the provider's branching API instead of
   * replaying history into a fresh session. On the initial query, nativeFork
   * takes precedence over `resumeAdapterSessionId` (see `resolveSessionIdentityOptions`).
   *
   * Consumed (set to `undefined`) after `system.init` confirms the child session.
   * Subsequent query rotations resume the confirmed child via `resumeAdapterSessionId`
   * and never re-apply the fork directive. This makes the one-shot invariant structural.
   *
   * - Tip fork (no `forkPointMessageId`): maps to SDK `forkSession`.
   * - Mid-history fork (with `forkPointMessageId`): maps to SDK `resumeSessionAt`.
   */
  nativeFork?: NativeForkDirective;
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

  /**
   * Tool allowlist granted by the caller (e.g. a workflow delegate's `allowedTools`).
   *
   * Entries use Makaio tool names (`read_file`, `edit_file`, `shell_exec`, ...) or MCP
   * names (`mcp__server__tool`); Claude Code names such as `Read` or `Bash` are rejected.
   * `shell_exec` accepts command rules: `shell_exec(git status)` (exact command) or
   * `shell_exec(git log:*)` (command prefix). Invalid entries throw a `ToolNameError`
   * when the query is built.
   *
   * When set, the SDK query exposes only the granted native built-in tools (SDK `tools`,
   * base names, e.g. `Bash` for `shell_exec(git status)`), and an adapter-owned PreToolUse
   * hook denies every tool call (built-in, MCP, or `Skill`) the list does not cover,
   * including shell commands outside a granted rule; the `canUseTool` handler checks the
   * lists again. Listed tools are not auto-approved: their calls still go through the
   * central tool approval service. While this list or `disallowedTools` is set,
   * provider-config `queryOptions.allowedTools` auto-approvals are dropped,
   * `queryOptions.permissionMode` is reset to `'default'`, and approval-granted
   * `updatedPermissions` are not forwarded, since each would skip `canUseTool` and
   * central approval. The SDK still auto-approves `Skill` calls derived from the `skills`
   * option; the hook denies them when the lists do not cover `Skill`. An
   * approver-rewritten input is re-checked against the lists. An empty array denies every
   * tool. `undefined` (with no `disallowedTools`) leaves tool availability and approval
   * unchanged.
   */
  allowedTools?: string[];
  /**
   * Tool denylist using Makaio tool names or MCP names, same entry syntax as
   * `allowedTools` (e.g. `shell_exec(rm -rf:*)`). Translated to native entries with
   * rules kept (`Bash(rm -rf:*)`) for SDK `disallowedTools`, and enforced per call by the
   * PreToolUse hook and the `canUseTool` handler; takes precedence over `allowedTools`.
   */
  disallowedTools?: string[];

  /**
   * When true, the session is ephemeral and must not persist its transcript.
   *
   * Ephemeral one-shot agents are by contract never resume/fork targets, so
   * writing a transcript to the provider's session store is wasteful and could
   * create orphaned session files. Connectors set `persistSession: false` in the
   * SDK query when this flag is set.
   */
  ephemeral?: boolean;
}
