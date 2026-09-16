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
 *
 * Subagent events (`SubagentStart`, `SubagentStop`) carry the PARENT session id
 * in `session_id`. `SubagentStart` has no own session id; `SubagentStop` adds
 * `agent_transcript_path` so downstream consumers can trigger targeted imports.
 * `PreCompact` fires before the client compacts its context window and carries
 * a `trigger` field (`'manual'` | `'auto'`).
 */
export const CLAUDE_CODE_HOOK_SESSION_START = 'SessionStart';
export const CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
export const CLAUDE_CODE_HOOK_PRE_TOOL_USE = 'PreToolUse';
export const CLAUDE_CODE_HOOK_POST_TOOL_USE = 'PostToolUse';
export const CLAUDE_CODE_HOOK_STOP = 'Stop';
export const CLAUDE_CODE_HOOK_SUBAGENT_START = 'SubagentStart';
export const CLAUDE_CODE_HOOK_SUBAGENT_STOP = 'SubagentStop';
export const CLAUDE_CODE_HOOK_PRE_COMPACT = 'PreCompact';
/**
 * PostCompact fires after the client has finished compacting its context window.
 *
 * Introduced in Claude Code 2.1.76 — above the `^2.1.0` floor but within the
 * supported range; on older supported binaries the wired hook is simply never
 * triggered. The hook carries a `trigger` field. It has no `frameworkSubject`;
 * the post-compaction framework signal is `client.session.started` with
 * `startMode: 'compact'`, delivered by the SessionStart hook that follows.
 * PostCompact is wired for raw ingress only.
 */
export const CLAUDE_CODE_HOOK_POST_COMPACT = 'PostCompact';

/**
 * Hook events that are Claude-specific and remain in raw space only.
 *
 * These events are not normalized into `client.session.*` observations
 * because they carry Claude Code-proprietary semantics (MCP connection
 * lifecycle, notification display) that do not map cleanly to the
 * framework-level session contract.
 */
export const CLAUDE_CODE_HOOK_NOTIFICATION = 'Notification';
export const CLAUDE_CODE_HOOK_MCP_SERVER_START = 'MCPServerStart';
export const CLAUDE_CODE_HOOK_MCP_SERVER_STOP = 'MCPServerStop';
