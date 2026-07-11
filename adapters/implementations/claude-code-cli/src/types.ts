import type {
  AIReasoningLevel,
  BaseAgentConnectorConfig,
  ConnectorSessionConfig,
  MessageHandle,
  MessageResult,
} from '@makaio/ai-adapters-core';
import type {
  McpResolvedServer,
  McpSessionContext,
  NativeForkDirective,
  ResponseSchemaDescriptor,
  SystemPrompt,
} from '@makaio/contracts';
import type { ClaudeCodeCliConnectorBus } from './namespace/index.js';
import type { ClaudeCodeCliProviderConfig } from './schemas.js';

/**
 * CLI-specific provider configuration for the connector.
 */
export interface ClaudeCliSpecificConfig {
  /** Maximum budget in USD for the CLI session */
  maxBudgetUsd?: number;
}

/**
 * Configuration for a Claude Code CLI connector.
 *
 * Extends BaseAgentConnectorConfig with CLI-specific options.
 */
export type ClaudeCliAgentConfig = BaseAgentConnectorConfig<ClaudeCodeCliConnectorBus, ClaudeCliSpecificConfig> & {
  /** Adapter instance ID (required by AIAgentConnector) */
  adapterId: string;
  /** Provider config from settings */
  providerConfig?: ClaudeCodeCliProviderConfig;
  /**
   * Upstream MCP servers from the resolved MCP session context.
   * Extracted from `mcpSessionContext.servers` in the adapter's connectorFactory.
   * When present, these servers are merged into the `--mcp-config` JSON alongside
   * the Makaio registry entry so the CLI subprocess can connect to them natively.
   */
  mcpUpstreamServers?: McpResolvedServer[];
  /**
   * Full resolved MCP session context including upstream server configs.
   * Overrides the base `LedgerSessionContext` to expose the complete shape
   * (servers + direct/discoverable tools) for the CLI adapter's native-passthrough mode.
   */
  mcpSessionContext?: McpSessionContext;
  /** Allowed Claude tool names or patterns to pass via `--allowedTools`. */
  allowedTools?: string[];
  /** Disallowed Claude tool names or patterns to pass via `--disallowedTools`. */
  disallowedTools?: string[];
  /**
   * Native fork directive from the session orchestrator.
   * Forwarded from the agent config into the connector and then to the CLI session.
   * The CLI adapter supports tip-only fork via `--resume <source> --fork-session`.
   */
  nativeFork?: NativeForkDirective;
};

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
 */
export type OnTurnCompleteCallback = (handle: MessageHandle, result: MessageResult) => void;

/**
 * Session configuration for the Claude Code CLI session.
 */
export interface ClaudeCliSessionConfig extends ConnectorSessionConfig<ClaudeCodeCliConnectorBus> {
  /** Agent ID for event correlation */
  agentId: string;
  /** Callback to emit SDK events through connector (for metadata injection) */
  emitSdkEvent?: EmitSdkEventCallback;
  /** Callback when turn starts processing a message */
  onTurnStart?: OnTurnStartCallback;
  /** Callback when turn completes */
  onTurnComplete?: OnTurnCompleteCallback;
  /** CLI-specific provider config */
  providerConfig?: ClaudeCodeCliProviderConfig;
  /** Previous adapter session ID for resume */
  resumeAdapterSessionId?: string;
  /** Predetermined session ID (from swapConnector) */
  predeterminedSessionId?: string;
  /**
   * Native fork directive from the session orchestrator.
   * When set, the CLI adapter uses `--resume <sourceId> --fork-session` to branch
   * from the tip of the source session. Mid-history fork (`forkPointMessageId`) is
   * not supported by the CLI and will throw at buildCliArgs time.
   */
  nativeFork?: NativeForkDirective;
  /**
   * System prompt to pass to the CLI.
   * - Plain string → `--system-prompt`
   * - `{ mode: 'append', content }` → `--append-system-prompt`
   */
  systemPrompt?: SystemPrompt;
  /**
   * Reasoning effort level to apply per-turn via the `--effort` CLI flag.
   * `'none'` suppresses the flag; all other levels map to their string equivalent,
   * except `'extra-high'` which maps to `'max'` (the CLI's accepted value).
   */
  reasoningEffort?: AIReasoningLevel;
  /** Allowed Claude tool names or patterns to pass via `--allowedTools`. */
  allowedTools?: string[];
  /** Disallowed Claude tool names or patterns to pass via `--disallowedTools`. */
  disallowedTools?: string[];
  /**
   * Absolute path to the `claude` CLI binary.
   * Falls back to `'claude'` (resolved via PATH) when omitted.
   */
  binaryPath?: string;
  /**
   * Milliseconds to wait for first stdout byte from the CLI subprocess before
   * killing it and emitting an error. Guards against silent hangs caused by
   * an invalid `--mcp-config`. Falls back to no timeout when omitted.
   */
  firstOutputTimeoutMs?: number;
  /** Makaio session ID for tool approval routing to the owning tab */
  makaioSessionId?: string;
  /**
   * Upstream MCP servers from the resolved MCP session context.
   * When present, merged into the `--mcp-config` JSON alongside the Makaio
   * registry entry so the CLI subprocess can connect to upstream servers natively.
   */
  mcpUpstreamServers?: McpResolvedServer[];
  /**
   * Per-turn structured output schema descriptor.
   * When present, passes `--json-schema <JSON>` to the CLI subprocess so the
   * model is constrained to respond with valid JSON matching the schema.
   */
  responseSchema?: ResponseSchemaDescriptor;
}
