import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Common session metadata fields.
 *
 * Extracted as a reusable schema since model and cwd appear in multiple contexts:
 * - Agent started events
 * - Import session context
 * - Fork detection results
 * - Cursor persistence
 */
export const SessionMetadataSchema = z.object({
  /** Model identifier (null if unknown, e.g., some external imports) */
  model: z.string().nullable(),
  /** Working directory (null if unknown, e.g., some external imports) */
  cwd: z.string().nullable(),
});

export type SessionMetadata = z.infer<typeof SessionMetadataSchema>;

/**
 * Discriminator for the reason an `agent.started` event was emitted.
 *
 * The `agent.started` subject fires once per turn dispatch — both for the
 * initial session start and for every subsequent turn. `startMode` tells
 * consumers *why* this particular start happened so they can filter
 * accordingly (e.g. SDK SessionStart hooks default to `['fresh', 'fork']`).
 *
 * - `fresh`    — Brand-new session with no prior conversation history.
 * - `resume`   — Continuation of an existing provider-native session
 *                (the SDK manages history internally).
 * - `fork`     — New provider session branched from an existing one via
 *                the provider's native fork/branch API.
 * - `rotation` — New provider session within an existing logical session.
 *                Covers connector swaps (model/cwd change), compression
 *                replays, and any turn dispatched as fresh-with-history
 *                into a session that already has prior turns.
 */
export const START_MODES = ['fresh', 'resume', 'fork', 'rotation'] as const;

/**
 * Zod schema for the start mode discriminator.
 */
export const StartModeSchema = z.enum(START_MODES);

/**
 * Start mode discriminator type.
 */
export type StartMode = z.infer<typeof StartModeSchema>;

/**
 * Agent execution started.
 *
 * Subject: `agent.started`
 * Type: Event (fire-and-forget)
 * Emitted when: An agent begins processing a turn. Fires once per turn
 * dispatch — use {@link StartMode} to distinguish the session lifecycle
 * phase.
 */
export const StartedSchema = BaseAgentEventSchema.merge(SessionMetadataSchema).extend({
  /**
   * Why this start event was emitted.
   *
   * Every emitter MUST supply this field — it is intentionally required
   * (not optional) so the compiler enforces coverage at every call site.
   * @see StartMode
   */
  startMode: StartModeSchema,
});

export type AgentStarted = z.infer<typeof StartedSchema>;
