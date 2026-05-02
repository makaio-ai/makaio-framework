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
 * Agent execution started.
 *
 * Subject: `agent.started`
 * Type: Event (fire-and-forget)
 * Emitted when: An agent begins processing a task
 */
export const StartedSchema = BaseAgentEventSchema.merge(SessionMetadataSchema);

export type AgentStarted = z.infer<typeof StartedSchema>;
