/**
 * Pure normalizer for Codex CLI hook events.
 *
 * Maps the Codex-native hook event names emitted on
 * `client:codex.hook.received` to their corresponding
 * `client.session.*` observed-semantics subjects.
 *
 * **Mapping table** (Codex event → global subject(s)):
 *
 * | Codex event name | Global subject(s)                                       |
 * |------------------|----------------------------------------------------------|
 * | `SessionStart`   | `client.session.started`                               |
 * | `UserPromptSubmit` | `client.session.turn.started`, then `client.session.userPrompt.submitted` |
 * | `Stop`           | `client.session.turn.completed`                        |
 * | `PreToolUse`     | `client.session.tool.pre`                              |
 * | `PostToolUse`    | `client.session.tool.post`                             |
 * | `SubagentStart`  | `client.session.subagent.started`                      |
 * | `SubagentStop`   | `client.session.subagent.completed`                    |
 * | `PreCompact`     | `client.session.compaction.pre`                        |
 * | `PostCompact`    | _(raw-only — no global subject)_                       |
 *
 * All other event names return an empty array — they are kept raw only and
 * are never emitted into the global `client.*` namespace.
 *
 * **Source notes:** Event names are verified against the pinned
 * `rust-v0.144.1` Codex source (`codex-rs/hooks/src/lib.rs`). Update this
 * normalizer when a new binary version changes or adds hook names.
 *
 * **Subagent hooks:** On both `SubagentStart` and `SubagentStop`, the raw
 * `session_id` is the PARENT session id. `adapterSessionId` on the base carries
 * it directly (no stripping). `agentId` identifies the subagent. `turnId` is
 * populated from `turn_id` when the Codex CLI includes it.
 * @packageDocumentation
 */

import { ClientSubjects, pickNonEmptyString } from '@makaio/subsystem-client';
import { CLIENT_SESSION_COMPACTION_TRIGGERS } from '@makaio/contracts/client';
import type {
  ClientSessionStarted,
  ClientSessionUserPromptSubmitted,
  ClientSessionTurnStarted,
  ClientSessionTurnCompleted,
  ClientSessionToolPre,
  ClientSessionToolPost,
  ClientSessionSubagentStarted,
  ClientSessionSubagentCompleted,
  ClientSessionCompactionPre,
  ClientSessionCompactionTrigger,
  ClientSessionStartMode,
} from '@makaio/contracts/client';
import type { RawClientHookPayload } from './schemas.js';
import {
  CODEX_HOOK_SESSION_START,
  CODEX_HOOK_USER_PROMPT_SUBMIT,
  CODEX_HOOK_PRE_TOOL_USE,
  CODEX_HOOK_POST_TOOL_USE,
  CODEX_HOOK_STOP,
  CODEX_HOOK_SUBAGENT_START,
  CODEX_HOOK_SUBAGENT_STOP,
  CODEX_HOOK_PRE_COMPACT,
} from './schemas.js';

/** Client ID used in all normalized payloads emitted by this normalizer. */
const CLIENT_ID = 'codex';
/** Source tag carried on all normalized observations. */
const SOURCE = 'native-hook' as const;

/**
 * Union of all normalized subject definitions the Codex normalizer can emit.
 *
 * Used as the element type of the array returned by {@link normalizeCodexHook}
 * to keep downstream consumers type-safe without wide `SubjectDefinition` casts.
 */
export type CodexNormalizedSubject =
  | typeof ClientSubjects.session.started
  | typeof ClientSubjects.session.userPrompt.submitted
  | typeof ClientSubjects.session.turn.started
  | typeof ClientSubjects.session.turn.completed
  | typeof ClientSubjects.session.tool.pre
  | typeof ClientSubjects.session.tool.post
  | typeof ClientSubjects.session.subagent.started
  | typeof ClientSubjects.session.subagent.completed
  | typeof ClientSubjects.session.compaction.pre;

/**
 * Union of all normalized payload types the Codex normalizer can produce.
 *
 * Mirrors the `client.session.*` schema union so callers do not need to
 * import individual payload types from `@makaio/contracts`.
 */
export type CodexNormalizedPayload =
  | ClientSessionStarted
  | ClientSessionUserPromptSubmitted
  | ClientSessionTurnStarted
  | ClientSessionTurnCompleted
  | ClientSessionToolPre
  | ClientSessionToolPost
  | ClientSessionSubagentStarted
  | ClientSessionSubagentCompleted
  | ClientSessionCompactionPre;

/**
 * Discriminated union of normalized Codex hook event results.
 *
 * Each variant pairs a specific `client.session.*` subject with its
 * corresponding strongly-typed payload. The caller switches on `subject`
 * to obtain a narrowed payload type and call `bus.emit` without casts.
 *
 * {@link normalizeCodexHook} returns an array of these — empty when the event
 * name is unknown (raw-only), and potentially more than one entry for hooks
 * that map to multiple bus events (e.g. `UserPromptSubmit` yields two).
 */
export type CodexNormalizedEvent =
  | { readonly subject: typeof ClientSubjects.session.started; readonly payload: ClientSessionStarted }
  | {
      readonly subject: typeof ClientSubjects.session.userPrompt.submitted;
      readonly payload: ClientSessionUserPromptSubmitted;
    }
  | { readonly subject: typeof ClientSubjects.session.turn.started; readonly payload: ClientSessionTurnStarted }
  | { readonly subject: typeof ClientSubjects.session.turn.completed; readonly payload: ClientSessionTurnCompleted }
  | { readonly subject: typeof ClientSubjects.session.tool.pre; readonly payload: ClientSessionToolPre }
  | { readonly subject: typeof ClientSubjects.session.tool.post; readonly payload: ClientSessionToolPost }
  | {
      readonly subject: typeof ClientSubjects.session.subagent.started;
      readonly payload: ClientSessionSubagentStarted;
    }
  | {
      readonly subject: typeof ClientSubjects.session.subagent.completed;
      readonly payload: ClientSessionSubagentCompleted;
    }
  | { readonly subject: typeof ClientSubjects.session.compaction.pre; readonly payload: ClientSessionCompactionPre };

/**
 * Known compaction trigger values reported by Codex.
 *
 * Derived from the contracts constant so it stays in sync without a separate
 * local enumeration that could drift.
 */
const COMPACTION_TRIGGERS: ReadonlySet<ClientSessionCompactionTrigger> = new Set(CLIENT_SESSION_COMPACTION_TRIGGERS);

/**
 * Map from the Codex CLI `SessionStart.source` union to the
 * framework-level {@link ClientSessionStartMode}.
 *
 * - `'startup'` → `'fresh'` (brand-new thread — **and a fork child**, see
 *   below; the owning service upgrades the fork case to `'fork'`)
 * - `'resume'`  → `'resume'` (thread continued from its own rollout file)
 * - `'clear'`   → `'clear'` (conversation cleared, new thread id)
 * - `'compact'` → `'compact'` (context compacted, same thread id)
 *
 * The vendor union has exactly these four values in the pinned `rust-v0.144.1`
 * source (`codex-rs/hooks/src/events/session_start.rs`, `SessionStartSource`);
 * there is no `'fork'` value. In `codex-rs/core/src/session/session.rs` a fork
 * is classified next to a brand-new thread — the match arm that maps
 * `InitialHistory::New` to `SessionStartSource::Startup` also covers
 * `InitialHistory::Forked` — which is why `'startup'`, not `'resume'`, is the
 * mode that may still turn out to be a fork.
 * Lineage is recovered from the rollout file instead; see the fork sniff in
 * `fork-sniff.ts` and its caller in `codex-client-session-service.ts`.
 *
 * Vendor values not in this map yield `undefined`, leaving `startMode`
 * absent from the normalized payload — safe for forward compatibility when
 * Codex adds new source values.
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
 * recognized value — keeping the normalizer tolerant of future CLI additions.
 * @param payload - Raw `SessionStart` hook payload
 * @returns Mapped start mode, or `undefined` when the source is unknown
 */
function resolveStartMode(payload: Record<string, unknown>): ClientSessionStartMode | undefined {
  const source = payload['source'];
  if (typeof source !== 'string') return undefined;
  return VENDOR_SOURCE_TO_START_MODE[source];
}

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
 * Extract the subagent identity from a subagent hook payload.
 *
 * Codex reports the agent identity under `agent_id` on both `SubagentStart`
 * and `SubagentStop` hook payloads.
 * @param payload - Raw subagent hook payload
 * @returns Agent ID string, or `undefined` when absent or empty
 */
function extractAgentId(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'agent_id');
}

/**
 * Extract the subagent type label from a subagent hook payload.
 *
 * Codex reports the agent type under `agent_type` on subagent hooks.
 * @param payload - Raw subagent hook payload
 * @returns Agent type string, or `undefined` when absent or empty
 */
function extractAgentType(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'agent_type');
}

/**
 * Extract the subagent transcript path from a `SubagentStop` payload.
 *
 * Codex may report the agent's own transcript path under
 * `agent_transcript_path` at subagent stop time.
 * @param payload - Raw `SubagentStop` hook payload
 * @returns Absolute transcript path, or `undefined` when absent or empty
 */
function extractAgentTranscriptPath(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'agent_transcript_path');
}

/**
 * Extract the turn correlation id from a subagent hook payload.
 *
 * Codex subagent hooks carry `turn_id` to correlate the hook event with the
 * parent turn that spawned the subagent.
 * @param payload - Raw subagent hook payload
 * @returns Turn id string, or `undefined` when absent or empty
 */
function extractTurnId(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'turn_id');
}

/**
 * Extract and map the compaction trigger from a `PreCompact` payload.
 *
 * Codex reports the trigger under `trigger` with values `'manual'` or
 * `'auto'`. Unknown values are dropped for forward compatibility.
 * @param payload - Raw `PreCompact` hook payload
 * @returns Mapped compaction trigger, or `undefined` when absent or unknown
 */
function extractCompactionTrigger(payload: Record<string, unknown>): ClientSessionCompactionTrigger | undefined {
  const trigger = payload['trigger'];
  if (typeof trigger !== 'string') return undefined;
  return (COMPACTION_TRIGGERS as ReadonlySet<string>).has(trigger)
    ? (trigger as ClientSessionCompactionTrigger)
    : undefined;
}

/**
 * Extract the transcript path from a raw Codex hook payload.
 *
 * Codex includes `transcript_path` on `SessionStart` and on the compaction
 * hooks; it is the absolute path of the thread's rollout JSONL file and is
 * serialized as `null` when no rollout has been materialized.
 * @param payload - Raw hook payload object
 * @returns Transcript path string, or `undefined` when absent or empty
 */
function extractTranscriptPath(payload: Record<string, unknown>): string | undefined {
  return pickNonEmptyString(payload, 'transcript_path');
}

/**
 * Shared base fields stamped onto every normalized Codex hook payload.
 *
 * Extracted here so helper functions can reference it without repeating the
 * full object shape inline.
 */
interface HookBase {
  readonly clientId: string;
  readonly source: typeof SOURCE;
  readonly observedAt: number;
  readonly adapterSessionId: string | undefined;
  readonly metadata: Record<string, unknown> | undefined;
}

/**
 * Normalize a `SubagentStart` hook payload into the subagent-started event.
 *
 * SubagentStart/Stop: the raw `session_id` is the PARENT session id.
 * `adapterSessionId` on the base carries it directly — it is the parent
 * session id, not a subagent own session id. `agentId` identifies the
 * subagent. `turnId` is populated from `turn_id` when present.
 * @param base - Full hook base (includes `adapterSessionId` = parent session id)
 * @param payload - Raw `SubagentStart` hook payload body
 * @returns Normalized event array, empty when `agentId` is absent
 */
function normalizeSubagentStart(base: HookBase, payload: Record<string, unknown>): CodexNormalizedEvent[] {
  const agentId = extractAgentId(payload);
  if (agentId === undefined) return [];
  const agentType = extractAgentType(payload);
  const turnId = extractTurnId(payload);
  return [
    {
      subject: ClientSubjects.session.subagent.started,
      payload: {
        ...base,
        agentId,
        ...(agentType !== undefined && { agentType }),
        ...(turnId !== undefined && { turnId }),
      },
    },
  ];
}

/**
 * Normalize a `SubagentStop` hook payload into the subagent-completed event.
 *
 * See {@link normalizeSubagentStart} for the `adapterSessionId` = parent
 * session id convention and `turnId` extraction.
 * @param base - Full hook base (includes `adapterSessionId` = parent session id)
 * @param payload - Raw `SubagentStop` hook payload body
 * @returns Normalized event array, empty when `agentId` is absent
 */
function normalizeSubagentStop(base: HookBase, payload: Record<string, unknown>): CodexNormalizedEvent[] {
  const agentId = extractAgentId(payload);
  if (agentId === undefined) return [];
  const agentType = extractAgentType(payload);
  const turnId = extractTurnId(payload);
  const agentTranscriptPath = extractAgentTranscriptPath(payload);
  return [
    {
      subject: ClientSubjects.session.subagent.completed,
      payload: {
        ...base,
        agentId,
        ...(agentType !== undefined && { agentType }),
        ...(turnId !== undefined && { turnId }),
        ...(agentTranscriptPath !== undefined && { agentTranscriptPath }),
      },
    },
  ];
}

/**
 * Normalize a `PreCompact` hook payload into the compaction-pre event.
 * @param base - Full hook base (includes `adapterSessionId`)
 * @param payload - Raw `PreCompact` hook payload body
 * @returns Single-element normalized event array
 */
function normalizePreCompact(base: HookBase, payload: Record<string, unknown>): CodexNormalizedEvent[] {
  const trigger = extractCompactionTrigger(payload);
  const transcriptPath = extractTranscriptPath(payload);
  return [
    {
      subject: ClientSubjects.session.compaction.pre,
      payload: {
        ...base,
        ...(trigger !== undefined && { trigger }),
        ...(transcriptPath !== undefined && { transcriptPath }),
      },
    },
  ];
}

/**
 * Normalize a raw Codex hook payload into `client.session.*` events.
 *
 * Returns an empty array for unknown or not-yet-modeled event names so the
 * caller skips global emission and keeps the event raw-only in
 * `client:codex.*`. A single hook may map to more than one normalized event:
 * `UserPromptSubmit` yields `turn.started` followed by `userPrompt.submitted`.
 * Emission order within the array is significant and must be preserved by the
 * caller.
 *
 * The `receivedAt` timestamp from the raw hook payload is used as `observedAt`
 * to preserve the original wall-clock time of the observation.
 * @param raw - Raw hook payload delivered on `client:codex.hook.received`
 * @param machineId - Stable runtime identity of the observing machine,
 *   caller-supplied by the owning client runtime. Stamped onto
 *   `client.session.started` so downstream storage receives the owning
 *   machine's identity without deriving it from the writer process.
 * @returns Normalized events with subject and typed payload, in emission
 *   order; empty when the event name is unknown (raw-only)
 */
export function normalizeCodexHook(raw: RawClientHookPayload, machineId?: string): CodexNormalizedEvent[] {
  const base: HookBase = {
    clientId: CLIENT_ID,
    source: SOURCE,
    observedAt: raw.receivedAt,
    adapterSessionId: extractAdapterSessionId(raw.payload),
    metadata: raw.metadata,
  };

  switch (raw.eventName) {
    case CODEX_HOOK_SESSION_START: {
      const startMode = resolveStartMode(raw.payload);
      // `transcript_path` is the rollout file Codex materializes for the
      // starting thread; it is the fork-lineage source the hook payload itself
      // does not carry. Null when the CLI could not materialize a rollout
      // (e.g. an ephemeral thread).
      const transcriptPath = extractTranscriptPath(raw.payload);
      return [
        {
          subject: ClientSubjects.session.started,
          payload: {
            ...base,
            ...(machineId !== undefined && { machineId }),
            ...(startMode !== undefined && { startMode }),
            ...(transcriptPath !== undefined && { transcriptPath }),
          },
        },
      ];
    }

    // UserPromptSubmit marks the beginning of an assistant turn; emitting
    // turn.started here gives observed sessions start-of-turn cadence (the
    // Stop hook remains the sole turn-completed trigger).
    case CODEX_HOOK_USER_PROMPT_SUBMIT:
      return [
        { subject: ClientSubjects.session.turn.started, payload: { ...base } },
        {
          subject: ClientSubjects.session.userPrompt.submitted,
          payload: { ...base, prompt: extractPrompt(raw.payload) },
        },
      ];

    case CODEX_HOOK_PRE_TOOL_USE:
      return [
        {
          subject: ClientSubjects.session.tool.pre,
          payload: { ...base, toolName: extractToolName(raw.payload), toolCallId: extractToolCallId(raw.payload) },
        },
      ];

    case CODEX_HOOK_POST_TOOL_USE:
      return [
        {
          subject: ClientSubjects.session.tool.post,
          payload: { ...base, toolName: extractToolName(raw.payload), toolCallId: extractToolCallId(raw.payload) },
        },
      ];

    case CODEX_HOOK_STOP:
      return [{ subject: ClientSubjects.session.turn.completed, payload: { ...base } }];

    // SubagentStart/Stop: adapterSessionId on the base carries the PARENT
    // session id (raw session_id). agentId identifies the subagent; turnId
    // comes from turn_id when present.
    case CODEX_HOOK_SUBAGENT_START:
      return normalizeSubagentStart(base, raw.payload);
    case CODEX_HOOK_SUBAGENT_STOP:
      return normalizeSubagentStop(base, raw.payload);
    case CODEX_HOOK_PRE_COMPACT:
      return normalizePreCompact(base, raw.payload);

    default:
      // PostCompact has no global subject (the post-compaction signal arrives
      // via a subsequent SessionStart with source 'compact'). All other
      // unknown / Codex-specific event names stay raw-only.
      return [];
  }
}
