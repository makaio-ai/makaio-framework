/**
 * Observed session semantics schemas for the client domain.
 *
 * Covers the shared base payload, all per-event schemas for normalized
 * lifecycle signals emitted by client adapters (`client.session.*`), and
 * the wiring entry schema used by `client.wiring.list`.
 *
 * Subjects: `client.session.started`, `client.session.userPrompt.submitted`,
 * `client.session.turn.started`, `client.session.turn.completed`,
 * `client.session.tool.pre`, `client.session.tool.post`,
 * `client.session.compaction.pre`, `client.session.subagent.started`,
 * `client.session.subagent.completed`.
 * @packageDocumentation
 */

import { z } from 'zod';
import { observability } from '@makaio/core';
import { EpochMillisecondsSchema, NonEmptyStringSchema } from './primitives.js';

/**
 * Shared base payload for all `client.session.*` observed-semantics events.
 *
 * These events are emitted by client adapters when they observe lifecycle
 * signals from the underlying client runtime. They are **not** control
 * messages — they carry normalized observations forwarded to the bus so
 * listeners can react without coupling to a specific adapter implementation.
 *
 * Fields:
 * - `clientId` — stable string ID of the client (e.g. `'claude-code'`).
 * - `source` — how the observation was captured (e.g. `'native-hook'`,
 *   `'adapter-derived'`).
 * - `observedAt` — Unix epoch timestamp in milliseconds when the signal
 *   was captured by the adapter.
 * - `sessionId` — framework session ID, if already resolved.
 * - `adapterSessionId` — raw session identifier from the client runtime,
 *   if available.
 * - `metadata` — arbitrary pass-through data from the adapter.
 */
export const ClientSessionObservedBaseSchema = z.object({
  /** Stable client ID (e.g. `'claude-code'`). */
  clientId: observability.attribute(NonEmptyStringSchema, 'makaio.client.id'),
  /**
   * How the observation was captured (e.g. `'native-hook'`,
   * `'adapter-derived'`).
   */
  source: observability.attribute(NonEmptyStringSchema, 'makaio.client.lifecycle.source'),
  /** Unix epoch timestamp in milliseconds when the signal was captured. */
  observedAt: observability.attribute(EpochMillisecondsSchema, 'event.observed_at'),
  /** Framework session ID, if already resolved at emission time. */
  sessionId: observability.attribute(z.string(), 'makaio.session.id').optional(),
  /** Raw session identifier from the client runtime, if available. */
  adapterSessionId: observability.attribute(z.string(), 'makaio.adapter.session_id').optional(),
  /** Arbitrary pass-through metadata from the adapter. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type ClientSessionObservedBase = z.infer<typeof ClientSessionObservedBaseSchema>;

/**
 * Payload for `client.session.started`.
 *
 * Emitted when an adapter observes that a new client session has begun.
 * This is a normalized observed signal — not a command. The session may not
 * yet be linked to a framework session at emission time.
 */
/**
 * Closed set of session start modes a client runtime can report.
 *
 * Narrower than the agent-level {@link StartMode}: a client can distinguish
 * `'fresh'` (new session) from `'fork'` (fork child), `'resume'`
 * (continuation of an existing session), `'clear'` (conversation cleared),
 * and `'compact'` (context compacted), but cannot know `'rotation'`
 * (a framework-level concept).
 *
 * Maps 1:1 to the Claude Code SDK `SessionStartHookInput.source` union:
 * `'startup'` → `'fresh'`, `'resume'` → `'resume'` or `'fork'` (after
 * transcript sniff), `'clear'` → `'clear'`, `'compact'` → `'compact'`.
 */
export const CLIENT_SESSION_START_MODES = ['fresh', 'fork', 'resume', 'clear', 'compact'] as const;

/** Zod schema for the client-reported session start mode. */
export const ClientSessionStartModeSchema = z.enum(CLIENT_SESSION_START_MODES);

/** Client-reported session start mode discriminator. */
export type ClientSessionStartMode = z.infer<typeof ClientSessionStartModeSchema>;

export const ClientSessionStartedSchema = ClientSessionObservedBaseSchema.extend({
  /**
   * Absolute path to the client's transcript/log file as reported by the
   * client runtime at session start (Claude Code hook payloads carry
   * `transcript_path` on every hook event per Anthropic's hooks contract).
   * Consumers use it to trigger targeted log imports without a prior
   * discovery scan.
   */
  transcriptPath: z.string().optional(),
  /**
   * Working directory reported by the client runtime at session start;
   * used to enrich session registration.
   */
  cwd: z.string().optional(),
  /**
   * Stable runtime identity of the machine that observed/owns this session.
   *
   * Caller-supplied by the client runtime that runs on the owning machine.
   * Storage handlers must never derive this value from the writer process
   * because ingestion may be performed by central or downstream servers.
   * Used by the native-locality evaluator to decide resume/fork vs degrade.
   */
  machineId: observability.attribute(z.string(), 'makaio.machine.id').optional(),
  /**
   * How this session was started, if the emitter can determine it.
   *
   * Absent when the signal source cannot distinguish start modes (e.g.
   * raw native hooks that carry no fork/resume indicator). When present,
   * `'fork'` signals that this session is a fork child and
   * {@link parentAdapterSessionId} carries the parent's adapter session id.
   */
  startMode: observability.attribute(ClientSessionStartModeSchema, 'makaio.session.start_mode').optional(),
  /**
   * Adapter session id of the parent session, when this session is a fork
   * child (`startMode === 'fork'`).
   *
   * Absent for non-fork sessions and when the emitter cannot determine the
   * parent identity.
   */
  parentAdapterSessionId: observability.attribute(z.string(), 'makaio.session.parent_adapter_session_id').optional(),
});

export type ClientSessionStarted = z.infer<typeof ClientSessionStartedSchema>;

/**
 * Payload for `client.session.userPrompt.submitted`.
 *
 * Emitted when an adapter observes that the user has submitted a prompt to
 * the client runtime. The `prompt` field carries the raw prompt text when
 * the adapter has access to it.
 */
export const ClientSessionUserPromptSubmittedSchema = ClientSessionObservedBaseSchema.extend({
  /** Raw prompt text, if available from the adapter. */
  prompt: NonEmptyStringSchema.optional(),
});

export type ClientSessionUserPromptSubmitted = z.infer<typeof ClientSessionUserPromptSubmittedSchema>;

/**
 * Payload for `client.session.turn.started`.
 *
 * Emitted when an adapter observes the beginning of an assistant turn inside
 * an ongoing client session.
 *
 * Intentionally base-only: unlike {@link ClientSessionTurnCompletedSchema},
 * this event carries no `transcriptPath`. The Stop hook (`turn.completed`) is
 * the import trigger for observed sessions; `turn.started` (mapped from
 * UserPromptSubmit) is cadence-only. Do not "fix" this asymmetry by adding
 * transcript fields here.
 */
export const ClientSessionTurnStartedSchema = ClientSessionObservedBaseSchema.extend({});

export type ClientSessionTurnStarted = z.infer<typeof ClientSessionTurnStartedSchema>;

/**
 * Payload for `client.session.turn.completed`.
 *
 * Emitted when an adapter observes that an assistant turn has finished inside
 * an ongoing client session.
 */
export const ClientSessionTurnCompletedSchema = ClientSessionObservedBaseSchema.extend({
  /**
   * Absolute path to the client's transcript/log file at turn completion
   * (Stop hook); the import trigger for observed sessions.
   */
  transcriptPath: z.string().optional(),
});

export type ClientSessionTurnCompleted = z.infer<typeof ClientSessionTurnCompletedSchema>;

/**
 * Payload for `client.session.tool.pre`.
 *
 * Emitted when an adapter observes that a tool call is about to be executed
 * by the client runtime. The `toolName` and `toolCallId` fields identify the
 * specific invocation when the adapter has access to them.
 */
export const ClientSessionToolPreSchema = ClientSessionObservedBaseSchema.extend({
  /** Tool name as reported by the client runtime (e.g. `'bash'`). */
  toolName: observability.attribute(NonEmptyStringSchema, 'tool.name').optional(),
  /** Opaque tool-call correlation ID assigned by the client runtime. */
  toolCallId: observability.attribute(NonEmptyStringSchema, 'tool.call_id').optional(),
});

export type ClientSessionToolPre = z.infer<typeof ClientSessionToolPreSchema>;

/**
 * Payload for `client.session.tool.post`.
 *
 * Emitted when an adapter observes that a tool call has completed inside the
 * client runtime. The `success` field reflects the outcome when the adapter
 * can determine it.
 */
export const ClientSessionToolPostSchema = ClientSessionObservedBaseSchema.extend({
  /** Tool name as reported by the client runtime (e.g. `'bash'`). */
  toolName: observability.attribute(NonEmptyStringSchema, 'tool.name').optional(),
  /** Opaque tool-call correlation ID assigned by the client runtime. */
  toolCallId: observability.attribute(NonEmptyStringSchema, 'tool.call_id').optional(),
  /**
   * Whether the tool call succeeded, as observed by the adapter.
   * Absent when the adapter cannot determine the outcome.
   */
  success: observability.attribute(z.boolean(), 'tool.success').optional(),
});

export type ClientSessionToolPost = z.infer<typeof ClientSessionToolPostSchema>;

/**
 * Closed set of compaction trigger types a client runtime can report.
 *
 * - `'manual'` — the user explicitly requested context compaction.
 * - `'auto'`   — the client runtime triggered compaction automatically
 *   (e.g. approaching the context-window limit).
 */
export const CLIENT_SESSION_COMPACTION_TRIGGERS = ['manual', 'auto'] as const;

/** Zod schema for the client-reported compaction trigger. */
export const ClientSessionCompactionTriggerSchema = z.enum(CLIENT_SESSION_COMPACTION_TRIGGERS);

/** Client-reported compaction trigger discriminator. */
export type ClientSessionCompactionTrigger = z.infer<typeof ClientSessionCompactionTriggerSchema>;

/**
 * Payload for `client.session.compaction.pre`.
 *
 * Fires BEFORE the client compacts its context window. The post-compaction
 * framework signal is `client.session.started` with `startMode: 'compact'`,
 * delivered by the SessionStart hook that fires after compaction on the SAME
 * session id. Both clients also fire a raw-only `PostCompact` hook carrying a
 * `trigger` field, but its ordering relative to `SessionStart(compact)` differs
 * by client: Codex fires `PreCompact → PostCompact → SessionStart(compact)`;
 * Claude Code fires `PreCompact → SessionStart(compact) → PostCompact`.
 * Consumers must treat `client.session.started{startMode:'compact'}` as the
 * authoritative post-compaction signal and must NOT assume it precedes or
 * follows the raw PostCompact hook.
 *
 * Three compaction signals together describe the full compaction lifecycle:
 * `client.session.compaction.pre` fires before compaction begins (from hooks,
 * carries `trigger` and `transcriptPath`); `client.session.started` with
 * `startMode: 'compact'` fires after compaction completes (from hooks, same
 * payload as a normal session start); and `SessionSubjects.session.compacted` (from `@makaio/contracts`) is emitted
 * post-hoc during transcript import, after the compacted session has been
 * ingested.
 *
 * Fields:
 * - `trigger` — how the compaction was initiated (`'manual'` or `'auto'`).
 *   Absent when the adapter cannot determine the trigger.
 * - `transcriptPath` — absolute path to the transcript file at the time of
 *   compaction, if available from the client runtime.
 */
export const ClientSessionCompactionPreSchema = ClientSessionObservedBaseSchema.extend({
  /**
   * How the compaction was initiated (`'manual'` or `'auto'`).
   * Absent when the adapter cannot determine the trigger.
   */
  trigger: observability
    .attribute(ClientSessionCompactionTriggerSchema, 'makaio.session.compaction_trigger')
    .optional(),
  /**
   * Absolute path to the transcript file at the time of compaction, if
   * available from the client runtime.
   */
  transcriptPath: z.string().optional(),
});

export type ClientSessionCompactionPre = z.infer<typeof ClientSessionCompactionPreSchema>;

/**
 * Payload for `client.session.subagent.started`.
 *
 * Emitted when a client-native subagent is observed via hooks. The subagent
 * event belongs to the parent session: `adapterSessionId` on the base carries
 * the parent session id (the same as every other `client.session.*` event),
 * which keeps subagent events joinable on `adapterSessionId`. The subagent
 * identity is `agentId`.
 *
 * Fields:
 * - `agentId`    — stable identity of the subagent as reported by the client
 *   runtime.
 * - `agentType`  — optional type label for the subagent (e.g. the agent type
 *   string reported by the client).
 * - `turnId`     — opaque turn correlation id, if available. Codex populates
 *   this from `turn_id`; Claude Code does not expose it.
 *
 * Note: this is the client-native OBSERVATION of a subagent (`agentId` = the
 * client's agent id, `adapterSessionId` = the owning session); it is distinct
 * from the framework's control-plane `subagent.*` namespace
 * (`SubagentSchemas`/`SubagentSubjects`, using `subagentId` and
 * `parentSessionId`) exported from `@makaio/contracts`. Client-native keys
 * (`makaio.client.agent_id`, `makaio.client.agent_type`, `makaio.client.turn_id`)
 * keep telemetry joins from attributing client-observed subagents to framework
 * agents that share the `makaio.agent.id` / `makaio.turn.id` namespace.
 */
export const ClientSessionSubagentStartedSchema = ClientSessionObservedBaseSchema.extend({
  /** Stable subagent identity as reported by the client runtime. */
  agentId: observability.attribute(NonEmptyStringSchema, 'makaio.client.agent_id'),
  /** Optional type label for the subagent (e.g. the agent type string). */
  agentType: observability.attribute(NonEmptyStringSchema, 'makaio.client.agent_type').optional(),
  /**
   * Opaque turn correlation id, if available from the client runtime.
   * Codex populates this from `turn_id`; Claude Code does not expose it.
   */
  turnId: observability.attribute(NonEmptyStringSchema, 'makaio.client.turn_id').optional(),
});

export type ClientSessionSubagentStarted = z.infer<typeof ClientSessionSubagentStartedSchema>;

/**
 * Payload for `client.session.subagent.completed`.
 *
 * Emitted when a client-native subagent completes. Extends
 * {@link ClientSessionSubagentStartedSchema} with an optional transcript path
 * so consumers can trigger targeted log imports for the finished subagent turn.
 *
 * Fields (in addition to {@link ClientSessionSubagentStartedSchema}):
 * - `agentTranscriptPath` — absolute path to the subagent's transcript file,
 *   if the client runtime exposes it at completion time.
 */
export const ClientSessionSubagentCompletedSchema = ClientSessionSubagentStartedSchema.extend({
  /**
   * Absolute path to the subagent's transcript file, if the client runtime
   * exposes it at completion time.
   */
  agentTranscriptPath: z.string().optional(),
});

export type ClientSessionSubagentCompleted = z.infer<typeof ClientSessionSubagentCompletedSchema>;

/**
 * A single wiring entry in a client `wiring.list` response.
 *
 * Represents one hook (or statusline) that Makaio can install into the
 * client's native config.
 */
export const ClientWiringEntrySchema = z.object({
  /** Wiring group identifier (e.g. `'session-events'`, `'usage-stream'`). */
  group: NonEmptyStringSchema,
  /**
   * Native hook event name (e.g. `'PreToolUse'`), or `'statusline'` for the
   * statusline proxy.
   */
  name: NonEmptyStringSchema,
  /** Whether this entry is currently installed in the target scope. */
  installed: z.boolean(),
  /** The command string that is or would be written to the config file. */
  command: NonEmptyStringSchema,
});

/** A single wiring entry in a list response. */
export type ClientWiringEntry = z.infer<typeof ClientWiringEntrySchema>;
