import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * External provider session closed.
 *
 * Subject: `adapter.session.closed`
 * Type: Event (fire-and-forget)
 * Emitted when: SDK session ends
 *
 * Re-emitted by AIAdapter when it receives AgentSubjects.session_closed.
 */
export const SessionClosedSchema = BaseAdapterEventSchema.extend({
  /** Agent that triggered the session close */
  agentId: z.string(),
  sessionId: z.string(),
  adapterSessionId: z.string(),
  reason: z.string().optional(),
});

export type SessionClosed = z.infer<typeof SessionClosedSchema>;
