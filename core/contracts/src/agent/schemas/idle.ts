import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Agent processing state transitioned to idle.
 *
 * Subject: `agent.idle`
 * Type: Event (fire-and-forget)
 * Emitted when: An agent's processing state transitions to 'idle'
 *
 * This event fires AFTER `agent.complete` and signals that the agent
 * is fully idle and ready for mutations like cwd.change or model.change.
 * Orchestration-level consumers (who don't have direct connector access)
 * can listen to this event to know when the agent is safe to mutate.
 */
export const IdleSchema = BaseAgentEventSchema;

export type IdlePayload = z.infer<typeof IdleSchema>;
