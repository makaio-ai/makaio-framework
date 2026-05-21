import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * Adapter session linked to a Makaio session.
 *
 * Subject: `adapter.session.linked`
 * Type: Event (fire-and-forget)
 * Emitted when: An imported adapter session is linked to a Makaio session
 *
 * Unlike session.discovered (which has no sessionId because the session
 * doesn't exist yet), this event confirms the linkage has been established.
 * Used to resolve parent relationships for sessions imported out of order.
 *
 * `adapterId` is optional here because linkage can occur during log import
 * before the owning adapter instance has been configured or started. Consumers
 * that need a resolved adapterId should use `AdapterRuntimeSubjects.resolveId`
 * separately through the runtime identity handlers.
 */
export const SessionLinkedSchema = BaseAdapterEventSchema.extend({
  /** Adapter instance identifier — optional for discovered sessions. */
  adapterId: z.string().optional(),

  /** Claude Code's session ID (from log file) */
  adapterSessionId: z.string(),

  /** The Makaio session ID this adapter session is now linked to */
  sessionId: z.string(),

  /** True when this event is intentionally replayed after transcript persistence. */
  replay: z.boolean().optional(),
});

export type SessionLinked = z.infer<typeof SessionLinkedSchema>;
