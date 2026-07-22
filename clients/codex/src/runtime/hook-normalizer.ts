/**
 * Pure normalizer for Codex CLI hook events.
 *
 * Maps the Codex-native hook event names emitted on
 * `client:codex.hook.received` to their corresponding
 * `client.session.*` observed-semantics subjects.
 *
 * **Mapping table** (Codex event → global subject):
 *
 * | Codex event name         | Global subject                          |
 * |--------------------------|------------------------------------------|
 * | `SessionStart`           | `client.session.started`                |
 * | `UserPromptSubmit`       | `client.session.userPrompt.submitted`   |
 * | `Stop`                   | `client.session.turn.completed`         |
 * | `PreToolUse`             | `client.session.tool.pre`               |
 * | `PostToolUse`            | `client.session.tool.post`              |
 *
 * All other event names are returned as `null` — they are kept raw only and
 * are never emitted into the global `client.*` namespace.
 *
 * **Source notes:** The Codex CLI hook event names above reflect the OpenAI
 * Codex CLI hook system as documented at the time of authoring. If the binary
 * changes its hook names, update {@link CODEX_EVENT_MAP} accordingly.
 * @packageDocumentation
 */

import { ClientSubjects, pickNonEmptyString } from '@makaio/subsystem-client';
import type {
  ClientSessionStarted,
  ClientSessionUserPromptSubmitted,
  ClientSessionTurnCompleted,
  ClientSessionToolPre,
  ClientSessionToolPost,
} from '@makaio/contracts/client';
import type { RawClientHookPayload } from './schemas.js';

/**
 * Union of all normalized subject definitions the Codex normalizer can emit.
 *
 * Used as the return type of {@link normalizeCodexHook} to keep downstream
 * consumers type-safe without wide `SubjectDefinition` casts.
 */
export type CodexNormalizedSubject =
  | typeof ClientSubjects.session.started
  | typeof ClientSubjects.session.userPrompt.submitted
  | typeof ClientSubjects.session.turn.completed
  | typeof ClientSubjects.session.tool.pre
  | typeof ClientSubjects.session.tool.post;

/**
 * Union of all normalized payload types the Codex normalizer can produce.
 *
 * Mirrors the `client.session.*` schema union so callers do not need to
 * import individual payload types from `@makaio/contracts`.
 */
export type CodexNormalizedPayload =
  | ClientSessionStarted
  | ClientSessionUserPromptSubmitted
  | ClientSessionTurnCompleted
  | ClientSessionToolPre
  | ClientSessionToolPost;

/**
 * Discriminated union of normalized Codex hook event results.
 *
 * Each variant pairs a specific `client.session.*` subject with its
 * corresponding strongly-typed payload.  The caller switches on `subject`
 * to obtain a narrowed payload type and call `bus.emit` without casts.
 *
 * When the event name is unknown, {@link normalizeCodexHook} returns `null`
 * to signal that the event must stay raw-only.
 */
export type CodexNormalizedEvent =
  | { readonly subject: typeof ClientSubjects.session.started; readonly payload: ClientSessionStarted }
  | {
      readonly subject: typeof ClientSubjects.session.userPrompt.submitted;
      readonly payload: ClientSessionUserPromptSubmitted;
    }
  | { readonly subject: typeof ClientSubjects.session.turn.completed; readonly payload: ClientSessionTurnCompleted }
  | { readonly subject: typeof ClientSubjects.session.tool.pre; readonly payload: ClientSessionToolPre }
  | { readonly subject: typeof ClientSubjects.session.tool.post; readonly payload: ClientSessionToolPost };

/**
 * Static map from Codex-native hook event name to the matching global subject.
 *
 * Update this map when the Codex CLI exposes new hook names that correspond
 * to global session lifecycle events.
 */
const CODEX_EVENT_MAP = new Map<string, CodexNormalizedSubject>([
  ['SessionStart', ClientSubjects.session.started],
  ['UserPromptSubmit', ClientSubjects.session.userPrompt.submitted],
  ['Stop', ClientSubjects.session.turn.completed],
  ['PreToolUse', ClientSubjects.session.tool.pre],
  ['PostToolUse', ClientSubjects.session.tool.post],
]);

/**
 * Extract optional session identifier from a raw Codex hook payload.
 *
 * Codex may report the session ID under `session_id` or `thread_id`.
 * Both are checked because early events may use `thread_id` before a
 * canonical session is established.
 * @param payload - Raw hook payload object forwarded by the ingress bridge
 * @returns Resolved adapter session ID string, or `undefined` when absent
 */
function extractAdapterSessionId(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'session_id') ?? pickNonEmptyString(payload, 'thread_id');
}

/**
 * Extract optional tool name from a raw Codex hook payload.
 *
 * Codex reports the tool name under `tool_name` for pre/post tool calls.
 * @param payload - Raw hook payload object
 * @returns Tool name string, or `undefined` when absent
 */
function extractToolName(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'tool_name');
}

/**
 * Extract optional tool call correlation ID from a raw Codex hook payload.
 * @param payload - Raw hook payload object
 * @returns Tool call ID string, or `undefined` when absent
 */
function extractToolCallId(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'tool_use_id');
}

/**
 * Extract optional prompt text from a raw Codex user-prompt payload.
 * @param payload - Raw hook payload object
 * @returns Non-empty prompt string, or `undefined` when absent
 */
function extractPrompt(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'prompt');
}

/**
 * Normalize a raw Codex hook payload into a `client.session.*` event.
 *
 * Returns `null` for unknown or not-yet-modeled event names so the caller
 * skips global emission and keeps the event raw-only in `client:codex.*`.
 * @param raw - Raw hook payload delivered on `client:codex.hook.received`
 * @param machineId - Stable runtime identity of the observing machine,
 *   caller-supplied by the owning client runtime. Stamped onto
 *   `client.session.started` so downstream storage receives the owning
 *   machine's identity without deriving it from the writer process.
 * @returns Normalized event with subject and typed payload, or `null` when
 *   the event name is unknown
 */
export function normalizeCodexHook(raw: RawClientHookPayload, machineId?: string): CodexNormalizedEvent | null {
  const subject = CODEX_EVENT_MAP.get(raw.eventName);
  if (subject === undefined) {
    return null;
  }

  const base = {
    clientId: 'codex',
    source: 'native-hook' as const,
    observedAt: raw.receivedAt,
    adapterSessionId: extractAdapterSessionId(raw.payload),
    metadata: raw.metadata,
  };

  switch (subject) {
    case ClientSubjects.session.started:
      return { subject, payload: { ...base, ...(machineId !== undefined && { machineId }) } };

    case ClientSubjects.session.userPrompt.submitted:
      return { subject, payload: { ...base, prompt: extractPrompt(raw.payload) } };

    case ClientSubjects.session.turn.completed:
      return { subject, payload: { ...base } };

    case ClientSubjects.session.tool.pre:
      return {
        subject,
        payload: {
          ...base,
          toolName: extractToolName(raw.payload),
          toolCallId: extractToolCallId(raw.payload),
        },
      };

    case ClientSubjects.session.tool.post:
      return {
        subject,
        payload: {
          ...base,
          toolName: extractToolName(raw.payload),
          toolCallId: extractToolCallId(raw.payload),
        },
      };

    default:
      // Guard against future CodexNormalizedSubject additions that are not yet
      // handled in this switch — keeps the map and the switch in sync over time.
      return null;
  }
}
