/**
 * Codex client runtime schemas and hook event name constants.
 *
 * Re-exports the shared raw hook payload schema for Codex client consumers.
 * The Codex CLI uses the canonical {@link RawClientHookPayloadSchema} delivered
 * on `client:codex.hook.received`.
 *
 * The hook name constants below are the canonical event names reported in the
 * `eventName` field of {@link RawClientHookPayload} by the Codex CLI.
 * @see https://github.com/openai/codex
 * @packageDocumentation
 */

export { RawClientHookPayloadSchema, type RawClientHookPayload } from '@makaio/subsystem-client';

/**
 * Hook events emitted by Codex that map to the v1 observed-semantics set.
 *
 * These are the events the normalizer translates into `client.session.*` bus
 * emissions. Any event NOT listed here is left as raw `client:codex`
 * namespace data only.
 */
export const CODEX_HOOK_SESSION_START = 'SessionStart';
export const CODEX_HOOK_USER_PROMPT_SUBMIT = 'UserPromptSubmit';
export const CODEX_HOOK_PRE_TOOL_USE = 'PreToolUse';
export const CODEX_HOOK_POST_TOOL_USE = 'PostToolUse';
export const CODEX_HOOK_STOP = 'Stop';
