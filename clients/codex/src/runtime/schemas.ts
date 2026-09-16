/**
 * Codex client runtime schemas and hook event name constants.
 *
 * Re-exports the shared raw hook payload schema for Codex client consumers.
 * The Codex CLI uses the canonical {@link RawClientHookPayloadSchema} delivered
 * on `client:codex.hook.received`.
 *
 * The hook name constants below are the canonical event names reported in the
 * `eventName` field of {@link RawClientHookPayload} by the Codex CLI.
 *
 * Event names are verified against the pinned `rust-v0.144.1` Codex source
 * (`codex-rs/hooks/src/lib.rs` — `HOOK_EVENT_NAMES` and
 * `engine/output_parser.rs`). The full set present in 0.144.1 is:
 * `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
 * `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
 * `PermissionRequest`. `SessionEnd` and `Interrupt` are NOT present.
 * @see https://github.com/openai/codex/tree/rust-v0.144.1/codex-rs/hooks
 * @packageDocumentation
 */

export { RawClientHookPayloadSchema, type RawClientHookPayload } from '@makaio/subsystem-client';

/**
 * Hook events emitted by Codex that map to the v1 observed-semantics set.
 *
 * These are the events the normalizer translates into `client.session.*` bus
 * emissions. Any event NOT listed here is left as raw `client:codex`
 * namespace data only.
 *
 * Event names are verified against pinned source `rust-v0.144.1`
 * (`codex-rs/hooks/src/lib.rs`).
 */
export const CODEX_HOOK_SESSION_START = 'SessionStart';
export const CODEX_HOOK_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
export const CODEX_HOOK_PRE_TOOL_USE = 'PreToolUse';
export const CODEX_HOOK_POST_TOOL_USE = 'PostToolUse';
export const CODEX_HOOK_STOP = 'Stop';
export const CODEX_HOOK_SUBAGENT_START = 'SubagentStart';
export const CODEX_HOOK_SUBAGENT_STOP = 'SubagentStop';
export const CODEX_HOOK_PRE_COMPACT = 'PreCompact';
export const CODEX_HOOK_POST_COMPACT = 'PostCompact';

/**
 * Fires when Codex asks the user for tool permission. Raw ingress only —
 * response surface not yet proven against the pinned CLI source, so no
 * capability is declared for this event.
 */
export const CODEX_HOOK_PERMISSION_REQUEST = 'PermissionRequest';
