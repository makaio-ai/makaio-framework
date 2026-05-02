/**
 * Observed session semantics schemas for the client domain.
 *
 * Covers the shared base payload, all per-event schemas for normalized
 * lifecycle signals emitted by client adapters (`client.session.*`), and
 * the wiring entry schema used by `client.wiring.list`.
 * @packageDocumentation
 */

import { z } from 'zod';
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
  clientId: NonEmptyStringSchema,
  /**
   * How the observation was captured (e.g. `'native-hook'`,
   * `'adapter-derived'`).
   */
  source: NonEmptyStringSchema,
  /** Unix epoch timestamp in milliseconds when the signal was captured. */
  observedAt: EpochMillisecondsSchema,
  /** Framework session ID, if already resolved at emission time. */
  sessionId: z.string().optional(),
  /** Raw session identifier from the client runtime, if available. */
  adapterSessionId: z.string().optional(),
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
export const ClientSessionStartedSchema = ClientSessionObservedBaseSchema.extend({});

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
 */
export const ClientSessionTurnStartedSchema = ClientSessionObservedBaseSchema.extend({});

export type ClientSessionTurnStarted = z.infer<typeof ClientSessionTurnStartedSchema>;

/**
 * Payload for `client.session.turn.completed`.
 *
 * Emitted when an adapter observes that an assistant turn has finished inside
 * an ongoing client session.
 */
export const ClientSessionTurnCompletedSchema = ClientSessionObservedBaseSchema.extend({});

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
  toolName: NonEmptyStringSchema.optional(),
  /** Opaque tool-call correlation ID assigned by the client runtime. */
  toolCallId: NonEmptyStringSchema.optional(),
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
  toolName: NonEmptyStringSchema.optional(),
  /** Opaque tool-call correlation ID assigned by the client runtime. */
  toolCallId: NonEmptyStringSchema.optional(),
  /**
   * Whether the tool call succeeded, as observed by the adapter.
   * Absent when the adapter cannot determine the outcome.
   */
  success: z.boolean().optional(),
});

export type ClientSessionToolPost = z.infer<typeof ClientSessionToolPostSchema>;

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
