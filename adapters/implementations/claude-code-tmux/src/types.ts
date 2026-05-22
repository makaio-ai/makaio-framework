import type {
  BaseAgentConnectorConfig,
  ConnectorSessionConfig,
  MessageHandle,
  MessageResult,
} from '@makaio/ai-adapters-core';
import type { McpResolvedServer, McpSessionContext, SystemPrompt } from '@makaio/contracts';
import type { IPtyProcess } from '@makaio/subsystem-native-session-supervisor';
import type { ClaudeCodeTmuxConnectorBus } from './namespace/index.js';
import type { ClaudeCodeTmuxProviderConfig } from './schemas.js';
import type { TmuxSession } from './session.js';

/**
 * Extension of {@link IPtyProcess} that exposes tmux-specific I/O capabilities.
 *
 * `TmuxBackend.spawn()` always returns a value that satisfies this interface.
 * Using it here instead of the base `IPtyProcess` makes the requirement explicit
 * at compile time and eliminates the need for runtime duck-type checks in
 * {@link TmuxSession}.
 */
export interface ITmuxPtyProcess extends IPtyProcess {
  /**
   * Send a tmux named key to the pane (e.g. `'Escape'`, `'Enter'`, `'C-c'`).
   *
   * Unlike `write()`, this uses `send-keys` without `-l`, so tmux interprets
   * the value as a key name rather than literal keystrokes.
   * @param key - tmux key name.
   */
  sendKey(key: string): void;

  /**
   * Capture the currently visible pane content.
   * @returns Visible pane text, or `null` when the pane no longer exists.
   */
  captureVisible(): string | null;
}

/** tmux-specific provider configuration for the connector. */
export type ClaudeCodeTmuxSpecificConfig = ClaudeCodeTmuxProviderConfig;

/**
 * Configuration for a Claude Code tmux connector.
 *
 * Extends BaseAgentConnectorConfig with tmux-specific options.
 */
export type ClaudeCodeTmuxAgentConfig = BaseAgentConnectorConfig<
  ClaudeCodeTmuxConnectorBus,
  ClaudeCodeTmuxSpecificConfig
> & {
  /** Adapter instance ID (required by AIAgentConnector). */
  adapterId: string;
  /** Provider config from settings. */
  providerConfig?: ClaudeCodeTmuxProviderConfig;
  /**
   * Upstream MCP servers from the resolved MCP session context.
   * Written to `.mcp.json` via the client service before launching Claude Code.
   */
  mcpUpstreamServers?: McpResolvedServer[];
  /**
   * Full resolved MCP session context including upstream server configs.
   */
  mcpSessionContext?: McpSessionContext;
};

/**
 * Session configuration for the Claude Code tmux session.
 *
 * Unlike the CLI adapter's per-turn config, tmux sessions are long-lived.
 * Configuration is set once at launch and persists for the session lifetime.
 */
export interface ClaudeCodeTmuxSessionConfig extends ConnectorSessionConfig<ClaudeCodeTmuxConnectorBus> {
  /** Agent ID for event correlation. */
  agentId: string;
  /** Provider config from settings. */
  providerConfig?: ClaudeCodeTmuxProviderConfig;
  /**
   * System prompt to pass to Claude Code at launch.
   * - Plain string → `--system-prompt`
   * - `{ mode: 'append', content }` → `--append-system-prompt`
   */
  systemPrompt?: SystemPrompt;
  /**
   * Absolute path to the `claude` CLI binary.
   * Falls back to `'claude'` (resolved via PATH) when omitted.
   */
  binaryPath?: string;
  /**
   * Working directory for the tmux session.
   * Also used as the project directory for `.mcp.json` and hook config.
   */
  projectDir: string;
  /** Makaio session ID for tool approval routing to the owning tab. */
  makaioSessionId?: string;
  /**
   * Upstream MCP servers written to `.mcp.json` before launch.
   */
  mcpUpstreamServers?: McpResolvedServer[];
}

/**
 * Configuration object for {@link TmuxConnectorSession}.
 *
 * Bundles all constructor-time dependencies into a single config, following
 * the same pattern as {@link ClaudeCodeTmuxSessionConfig} and the CLI adapter's
 * `ClaudeCliSessionConfig`.
 */
export interface TmuxConnectorSessionConfig {
  /** The underlying tmux session for sending messages and waiting for terminal state. */
  tmuxSession: TmuxSession;
  /** Scoped bus for turn event emission. */
  bus: ClaudeCodeTmuxConnectorBus;
  /** Adapter instance identifier. */
  adapterId: string;
  /** Adapter type name. */
  adapterName: string;
  /** Owning agent identifier. */
  agentId: string;
  /** Called when a new turn begins. */
  onTurnStart: (handle: MessageHandle) => void;
  /** Called when the turn finishes. */
  onTurnComplete: (handle: MessageHandle, result: MessageResult) => void;
  /** Emits assistant completion text. */
  emitTurnCompleted: (payload: { message: string }) => Promise<void>;
  /** Emits tool-start metadata. */
  emitToolUseStarted: (payload: { toolName: string; toolUseId: string; toolInput: unknown }) => Promise<void>;
  /** Emits tool-finish metadata. */
  emitToolUseFinished: (payload: {
    toolName: string;
    toolUseId: string;
    toolResult: unknown;
    isError?: boolean;
  }) => Promise<void>;
  /** Time in milliseconds to let Claude Code settle after sending ESC. */
  interruptSettleMs: number;
}
