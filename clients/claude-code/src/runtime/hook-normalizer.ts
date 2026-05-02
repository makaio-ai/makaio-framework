/**
 * Claude Code hook normalizer — translates raw `client:claude-code.hook.received`
 * payloads into normalized `client.session.*` observed-semantics events.
 *
 * ## Design principles
 *
 * - **Pure function**: `normalizeClaudeCodeHook` takes a single
 * {@link RawClientHookPayload} and returns a normalized result or `null`.  It
 * has no bus or service dependencies — tests exercise it directly without any
 * bus setup.
 *
 * - **No ingress filtering**: the normalizer is called *after* the raw event
 * has been received on `client:claude-code.hook.received`.  Unknown events
 * return `null`; the caller decides whether to act on the result.
 *
 * - **Claude-specific extras stay raw**: `SubagentStop`, `Notification`,
 * `MCPServerStart`, and `MCPServerStop` are not normalizable — they do not
 * return a result and are not forwarded to the global `client.session.*`
 * namespace.
 * @packageDocumentation
 */

import { ClientSubjects, pickNonEmptyString } from '@makaio/clients-core';
import type { RawClientHookPayload } from '@makaio/clients-core';
import type {
  ClientSessionStarted,
  ClientSessionUserPromptSubmitted,
  ClientSessionTurnCompleted,
  ClientSessionToolPre,
  ClientSessionToolPost,
} from '@makaio/contracts/client';
import {
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
} from './schemas.js';

/** Client ID used in all normalized payloads emitted by this normalizer. */
const CLIENT_ID = 'claude-code';
/** Source tag carried on all normalized observations. */
const SOURCE = 'native-hook';

/**
 * Union type of all `client.session.*` observed-semantics subject definitions
 * the normalizer can produce.
 *
 * Uses `typeof ClientSubjects.session.*` references so downstream consumers
 * receive proper {@link SubjectDefinition} objects rather than plain strings.
 */
export type ClaudeCodeNormalizedSubject =
  | typeof ClientSubjects.session.started
  | typeof ClientSubjects.session.userPrompt.submitted
  | typeof ClientSubjects.session.turn.completed
  | typeof ClientSubjects.session.tool.pre
  | typeof ClientSubjects.session.tool.post;

/**
 * Discriminated union of normalized event results.
 *
 * Each variant pairs a specific `client.session.*` subject definition with its
 * corresponding strongly-typed payload.  The caller switches on `subject` to
 * obtain a narrowed payload type and call `bus.emit` without casts.
 *
 * When the event name is unknown, {@link normalizeClaudeCodeHook} returns
 * `null` to signal that the event must stay raw-only.
 */
export type ClaudeCodeNormalizedEvent =
  | { readonly subject: typeof ClientSubjects.session.started; readonly payload: ClientSessionStarted }
  | {
      readonly subject: typeof ClientSubjects.session.userPrompt.submitted;
      readonly payload: ClientSessionUserPromptSubmitted;
    }
  | { readonly subject: typeof ClientSubjects.session.turn.completed; readonly payload: ClientSessionTurnCompleted }
  | { readonly subject: typeof ClientSubjects.session.tool.pre; readonly payload: ClientSessionToolPre }
  | { readonly subject: typeof ClientSubjects.session.tool.post; readonly payload: ClientSessionToolPost };

/**
 * Static map from Claude Code-native hook event name to the matching global
 * subject definition.
 *
 * Checked before base construction so unknown events exit early without any
 * allocation overhead. Update this map when the Claude Code CLI exposes new
 * hook names that correspond to global session lifecycle events.
 */
const CLAUDE_CODE_EVENT_MAP = new Map<string, ClaudeCodeNormalizedSubject>([
  [CLAUDE_CODE_HOOK_SESSION_START, ClientSubjects.session.started],
  [CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT, ClientSubjects.session.userPrompt.submitted],
  [CLAUDE_CODE_HOOK_PRE_TOOL_USE, ClientSubjects.session.tool.pre],
  [CLAUDE_CODE_HOOK_POST_TOOL_USE, ClientSubjects.session.tool.post],
  [CLAUDE_CODE_HOOK_STOP, ClientSubjects.session.turn.completed],
]);

/**
 * Normalize a raw Claude Code hook payload into a `client.session.*` event.
 *
 * Returns `null` for unknown or not-yet-modeled event names so the caller
 * skips global emission and keeps the event raw-only in `client:claude-code.*`.
 *
 * The `receivedAt` timestamp from the raw hook payload is used as `observedAt`
 * to preserve the original wall-clock time of the observation.
 * @param raw - Raw hook payload delivered on `client:claude-code.hook.received`
 * @returns Normalized event with subject and typed payload, or `null` when the
 *   event name is unknown
 */
export function normalizeClaudeCodeHook(raw: RawClientHookPayload): ClaudeCodeNormalizedEvent | null {
  const subject = CLAUDE_CODE_EVENT_MAP.get(raw.eventName);
  if (subject === undefined) {
    return null;
  }

  const base = {
    clientId: CLIENT_ID,
    source: SOURCE,
    observedAt: raw.receivedAt,
    adapterSessionId: resolveSessionId(raw.payload),
    metadata: raw.metadata,
  };

  switch (subject) {
    case ClientSubjects.session.started:
      return { subject, payload: { ...base } };

    case ClientSubjects.session.userPrompt.submitted:
      return { subject, payload: { ...base, prompt: resolvePrompt(raw.payload) } };

    case ClientSubjects.session.tool.pre: {
      const toolName = resolveToolName(raw.payload);
      const toolCallId = resolveToolCallId(raw.payload);
      return {
        subject,
        payload: {
          ...base,
          ...(toolName !== undefined && { toolName }),
          ...(toolCallId !== undefined && { toolCallId }),
        },
      };
    }

    case ClientSubjects.session.tool.post: {
      const toolName = resolveToolName(raw.payload);
      const toolCallId = resolveToolCallId(raw.payload);
      const success = resolveToolSuccess(raw.payload);
      return {
        subject,
        payload: {
          ...base,
          ...(toolName !== undefined && { toolName }),
          ...(toolCallId !== undefined && { toolCallId }),
          ...(success !== undefined && { success }),
        },
      };
    }

    case ClientSubjects.session.turn.completed:
      return { subject, payload: { ...base } };

    default:
      // Guard against future ClaudeCodeNormalizedSubject additions that are
      // not yet handled in this switch — keeps the map and the switch in sync.
      return null;
  }
}

/**
 * Extract a session ID from the raw hook payload.
 *
 * Claude Code places the session ID under `session_id` at the top level of
 * the hook payload.
 * @param payload - Raw hook payload object
 * @returns Session ID string, or `undefined` when absent
 */
function resolveSessionId(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'session_id');
}

/**
 * Extract the user prompt text from a `UserPromptSubmit` payload.
 *
 * Claude Code reports the prompt under `prompt`.
 * @param payload - Raw `UserPromptSubmit` payload
 * @returns Prompt string, or `undefined` when absent or empty
 */
function resolvePrompt(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'prompt');
}

/**
 * Extract the tool name from a tool-use hook payload.
 *
 * Claude Code reports the tool name under `tool_name`.
 * @param payload - Raw `PreToolUse` or `PostToolUse` payload
 * @returns Tool name string, or `undefined` when absent
 */
function resolveToolName(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'tool_name');
}

/**
 * Extract the tool call ID from a tool-use hook payload.
 *
 * Claude Code reports the tool call ID under `tool_use_id`.
 * @param payload - Raw `PreToolUse` or `PostToolUse` payload
 * @returns Tool call ID string, or `undefined` when absent
 */
function resolveToolCallId(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'tool_use_id');
}

/**
 * Extract the tool success indicator from a `PostToolUse` payload.
 *
 * Claude Code reports success under `exit_code` where `0` means success.
 * The field is optional; when absent the outcome is unknown.
 * @param payload - Raw `PostToolUse` payload
 * @returns `true` when exit_code is 0, `false` when non-zero, or `undefined`
 *   when the field is absent
 */
function resolveToolSuccess(payload: Record<string, unknown>): boolean | undefined {
  const code = payload['exit_code'];
  if (typeof code !== 'number') return undefined;
  return code === 0;
}
