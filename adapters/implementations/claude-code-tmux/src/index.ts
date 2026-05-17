/**
 * @packageDocumentation
 * Claude Code tmux adapter — runs Claude Code interactively in a tmux session.
 *
 * Three-channel orchestration model:
 * - **Hooks** — lifecycle events from Claude Code (SessionStart, PreToolUse, PostToolUse, Stop)
 * - **MCP** — bidirectional tool orchestration via `.mcp.json`
 * - **tmux** — user input + visual attach
 */

// Definition and extension manifest
export { adapterDefinition } from './definition.js';
export { claudeCodeTmuxPackage } from './package.js';

// Constants
export { ADAPTER_NAME, ADAPTER_DISPLAY_NAME, TMUX_SERVER_NAME, DEFAULT_TIMEOUTS } from './constants.js';

// Schemas and types
export { ClaudeCodeTmuxProviderConfigSchema, type ClaudeCodeTmuxProviderConfig } from './schemas.js';
export type {
  ClaudeCodeTmuxAgentConfig,
  ClaudeCodeTmuxSessionConfig,
  ClaudeCodeTmuxSpecificConfig,
  ITmuxPtyProcess,
  TmuxConnectorSessionConfig,
} from './types.js';

// Provider
export { providerIds, defaultPresetId, testPresetId } from './provider.js';

// Namespace and bus types
export {
  CLAUDE_CODE_TMUX_NAMESPACE,
  ClaudeCodeTmuxConnectorNamespace,
  ClaudeCodeTmuxConnectorSubjects,
  TurnCompletedSchema,
  TmuxToolUseStartedSchema,
  TmuxToolUseFinishedSchema,
  type ClaudeCodeTmuxConnectorBus,
} from './namespace/index.js';

// Config factory
export { ClaudeCodeTmuxConfig } from './config.js';

// Adapter
export { ClaudeCodeTmuxAdapter, createClaudeCodeTmuxAdapter, type ClaudeCodeTmuxAdapterConfig } from './adapter.js';

// Agent
export { ClaudeCodeTmuxAgent } from './agent.js';

// Connector
export { ClaudeCodeTmuxConnector } from './connector.js';

// Turn
export { TmuxConnectorTurn } from './turn.js';

// Session
export { TmuxSession, type TmuxSessionConfig } from './session.js';

// Hook event routing
export { createHookEventRouter, type HookEventCallbacks } from './utils/hook-event-router.js';

// MCP settings helpers
export { addMcpServerToProject, removeMcpServerFromProject } from './utils/mcp-settings.js';
