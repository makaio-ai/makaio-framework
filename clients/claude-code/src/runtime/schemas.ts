/**
 * Claude Code hook event name constants and normalizable event classification.
 *
 * Claude Code fires hooks at lifecycle boundaries inside a running session.
 * The hook names below are the canonical event names reported in the
 * `eventName` field of {@link RawClientHookPayload}.
 * @see https://docs.anthropic.com/en/docs/claude-code/hooks
 * @packageDocumentation
 */

/**
 * Hook events emitted by Claude Code that map to the v1 observed-semantics set.
 *
 * These are the events the normalizer translates into `client.session.*` bus
 * emissions. Any event NOT listed here is left as raw `client:claude-code`
 * namespace data only.
 */
export const CLAUDE_CODE_HOOK_SESSION_START = 'SessionStart';
export const CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
export const CLAUDE_CODE_HOOK_PRE_TOOL_USE = 'PreToolUse';
export const CLAUDE_CODE_HOOK_POST_TOOL_USE = 'PostToolUse';
export const CLAUDE_CODE_HOOK_STOP = 'Stop';

/**
 * Hook events that are Claude-specific and remain in raw space only.
 *
 * These events are not normalized into `client.session.*` observations
 * because they carry Claude Code-proprietary semantics (subagent coordination,
 * MCP connection lifecycle, notification display) that do not map cleanly to
 * the framework-level session contract.
 */
export const CLAUDE_CODE_HOOK_SUBAGENT_STOP = 'SubagentStop';
export const CLAUDE_CODE_HOOK_NOTIFICATION = 'Notification';
export const CLAUDE_CODE_HOOK_MCP_SERVER_START = 'MCPServerStart';
export const CLAUDE_CODE_HOOK_MCP_SERVER_STOP = 'MCPServerStop';
