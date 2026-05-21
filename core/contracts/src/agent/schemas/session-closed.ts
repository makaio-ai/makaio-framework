import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Agent session closed.
 *
 * Subject: `agent.session.closed`
 * Type: Event (fire-and-forget)
 * Emitted when: Agent session ends (abort, close, or natural completion)
 *
 * AIAdapter listens to this and re-emits as AdapterSubjects.session.closed.
 * This maintains proper layering: agent emits agent-level events,
 * adapter translates to adapter-level events.
 */
export const SessionClosedSchema = BaseAgentEventSchema.extend({
  /** Reason for session closure */
  reason: z.string().optional(),
});

export type SessionClosed = z.infer<typeof SessionClosedSchema>;
