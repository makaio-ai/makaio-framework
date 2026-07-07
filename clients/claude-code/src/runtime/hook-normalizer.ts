/**
 * Claude Code hook normalizer — translates raw `client:claude-code.hook.received`
 * payloads into normalized `client.session.*` observed-semantics events.
 *
 * ## Design principles
 *
 * - **Pure function**: `normalizeClaudeCodeHook` takes a single
 * {@link RawClientHookPayload} and returns an array of normalized results.  It
 * has no bus or service dependencies — tests exercise it directly without any
 * bus setup.
 *
 * - **No ingress filtering**: the normalizer is called *after* the raw event
 * has been received on `client:claude-code.hook.received`.  Unknown events
 * return an empty array; the caller decides whether to act on the result.
 *
 * - **One hook may map to multiple events**: `UserPromptSubmit` produces both
 * `client.session.turn.started` and `client.session.userPrompt.submitted`, in
 * that order.  All other known hooks produce exactly one event.
 *
 * - **Claude-specific extras stay raw**: `SubagentStop`, `Notification`,
 * `MCPServerStart`, and `MCPServerStop` are not normalizable — they do not
 * return a result and are not forwarded to the global `client.session.*`
 * namespace.
 * @packageDocumentation
 */

import { ClientSubjects, pickNonEmptyString } from '@makaio/subsystem-client';
import type { RawClientHookPayload } from '@makaio/subsystem-client';
import type {
  ClientSessionStarted,
  ClientSessionStartMode,
  ClientSessionUserPromptSubmitted,
  ClientSessionTurnStarted,
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
  | typeof ClientSubjects.session.turn.started
  | typeof ClientSubjects.session.turn.completed
  | typeof ClientSubjects.session.tool.pre
  | typeof ClientSubjects.session.tool.post;

/**
 * Discriminated union of normalized event results.
 *
 * Each variant pairs a specific `client.session.*` subject definition with its
 * corresponding strongly-typed payload.  The caller switches on `subject` to
 * obtain a narrowed payload type and call `bus.emit` without casts.
 */
export type ClaudeCodeNormalizedEvent =
  | { readonly subject: typeof ClientSubjects.session.started; readonly payload: ClientSessionStarted }
  | {
      readonly subject: typeof ClientSubjects.session.userPrompt.submitted;
      readonly payload: ClientSessionUserPromptSubmitted;
    }
  | { readonly subject: typeof ClientSubjects.session.turn.started; readonly payload: ClientSessionTurnStarted }
  | { readonly subject: typeof ClientSubjects.session.turn.completed; readonly payload: ClientSessionTurnCompleted }
  | { readonly subject: typeof ClientSubjects.session.tool.pre; readonly payload: ClientSessionToolPre }
  | { readonly subject: typeof ClientSubjects.session.tool.post; readonly payload: ClientSessionToolPost };

/**
 * Normalize a raw Claude Code hook payload into `client.session.*` events.
 *
 * Returns an empty array for unknown or not-yet-modeled event names so the
 * caller skips global emission and keeps the event raw-only in
 * `client:claude-code.*`.  A single hook may map to more than one normalized
 * event: `UserPromptSubmit` yields `turn.started` followed by
 * `userPrompt.submitted`.  Emission order within the array is significant and
 * must be preserved by the caller.
 *
 * The `receivedAt` timestamp from the raw hook payload is used as `observedAt`
 * to preserve the original wall-clock time of the observation.
 * @param raw - Raw hook payload delivered on `client:claude-code.hook.received`
 * @param machineId - Stable runtime identity of the observing machine,
 *   caller-supplied by the owning client runtime. Stamped onto
 *   `client.session.started` so downstream storage receives the owning
 *   machine's identity without deriving it from the writer process.
 * @returns Normalized events with subject and typed payload, in emission
 *   order; empty when the event name is unknown (raw-only)
 */
export function normalizeClaudeCodeHook(raw: RawClientHookPayload, machineId?: string): ClaudeCodeNormalizedEvent[] {
  const base = {
    clientId: CLIENT_ID,
    source: SOURCE,
    observedAt: raw.receivedAt,
    adapterSessionId: resolveSessionId(raw.payload),
    metadata: raw.metadata,
  };

  switch (raw.eventName) {
    case CLAUDE_CODE_HOOK_SESSION_START: {
      const transcriptPath = resolveTranscriptPath(raw.payload);
      const cwd = resolveCwd(raw.payload);
      const startMode = resolveStartMode(raw.payload);
      return [
        {
          subject: ClientSubjects.session.started,
          payload: {
            ...base,
            ...(transcriptPath !== undefined && { transcriptPath }),
            ...(cwd !== undefined && { cwd }),
            ...(machineId !== undefined && { machineId }),
            ...(startMode !== undefined && { startMode }),
          },
        },
      ];
    }

    // UserPromptSubmit marks the beginning of an assistant turn; emitting
    // turn.started here gives observed sessions start-of-turn cadence (the
    // Stop hook remains the sole import trigger).
    case CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT:
      return [
        { subject: ClientSubjects.session.turn.started, payload: { ...base } },
        {
          subject: ClientSubjects.session.userPrompt.submitted,
          payload: { ...base, prompt: resolvePrompt(raw.payload) },
        },
      ];

    case CLAUDE_CODE_HOOK_PRE_TOOL_USE: {
      const toolName = resolveToolName(raw.payload);
      const toolCallId = resolveToolCallId(raw.payload);
      return [
        {
          subject: ClientSubjects.session.tool.pre,
          payload: {
            ...base,
            ...(toolName !== undefined && { toolName }),
            ...(toolCallId !== undefined && { toolCallId }),
          },
        },
      ];
    }

    case CLAUDE_CODE_HOOK_POST_TOOL_USE: {
      const toolName = resolveToolName(raw.payload);
      const toolCallId = resolveToolCallId(raw.payload);
      const success = resolveToolSuccess(raw.payload);
      return [
        {
          subject: ClientSubjects.session.tool.post,
          payload: {
            ...base,
            ...(toolName !== undefined && { toolName }),
            ...(toolCallId !== undefined && { toolCallId }),
            ...(success !== undefined && { success }),
          },
        },
      ];
    }

    case CLAUDE_CODE_HOOK_STOP: {
      const transcriptPath = resolveTranscriptPath(raw.payload);
      return [
        {
          subject: ClientSubjects.session.turn.completed,
          payload: { ...base, ...(transcriptPath !== undefined && { transcriptPath }) },
        },
      ];
    }

    default:
      // Unknown / Claude-specific event names stay raw-only.  Update this
      // switch when the Claude Code CLI exposes new hook names that map to
      // global session lifecycle events.
      return [];
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
 * Extract the transcript file path from the raw hook payload.
 *
 * Claude Code includes `session_id`, `transcript_path`, and `cwd` in every
 * hook input; the transcript path points at the JSONL log for the session and
 * lets consumers trigger targeted imports without a discovery scan.
 * @param payload - Raw hook payload object
 * @returns Absolute transcript path, or `undefined` when absent or empty
 */
function resolveTranscriptPath(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'transcript_path');
}

/**
 * Extract the working directory from the raw hook payload.
 *
 * Claude Code includes `session_id`, `transcript_path`, and `cwd` in every
 * hook input; the working directory enriches session registration.
 * @param payload - Raw hook payload object
 * @returns Working directory path, or `undefined` when absent or empty
 */
function resolveCwd(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'cwd');
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

/**
 * Map from the Claude Code SDK `SessionStartHookInput.source` union to the
 * framework-level {@link ClientSessionStartMode}.
 *
 * - `'startup'` → `'fresh'` (brand-new session)
 * - `'resume'`  → `'resume'` (tentative; caller upgrades to `'fork'` after
 *   transcript sniff when foreign session IDs are found)
 * - `'clear'`   → `'clear'` (conversation cleared, same session ID)
 * - `'compact'` → `'compact'` (context compacted, same session ID)
 *
 * Vendor values not in this map yield `undefined`, leaving `startMode`
 * absent from the normalized payload — safe for forward compatibility when
 * Anthropic adds new source values.
 */
const VENDOR_SOURCE_TO_START_MODE: Readonly<Record<string, ClientSessionStartMode>> = {
  startup: 'fresh',
  resume: 'resume',
  clear: 'clear',
  compact: 'compact',
};

/**
 * Extract the `source` field from a `SessionStart` hook payload and map it
 * to a {@link ClientSessionStartMode}.
 *
 * Returns `undefined` when the field is absent, non-string, or not a
 * recognized value — keeping the normalizer tolerant of future SDK
 * additions.
 * @param payload - Raw `SessionStart` hook payload
 * @returns Mapped start mode, or `undefined` when the source is unknown
 */
function resolveStartMode(payload: Record<string, unknown>): ClientSessionStartMode | undefined {
  const source = payload['source'];
  if (typeof source !== 'string') return undefined;
  return VENDOR_SOURCE_TO_START_MODE[source];
}
