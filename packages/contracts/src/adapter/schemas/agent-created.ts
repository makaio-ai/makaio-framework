import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * Agent execution unit created.
 *
 * Subject: `adapter.agent.created`
 * Type: Event (fire-and-forget)
 * Emitted when: Adapter spawns a new agent execution unit
 */
export const AgentCreatedSchema = BaseAdapterEventSchema.extend({
  agentId: z.string(),
  sessionId: z.string(),
  adapterSessionId: z.string().optional(),
});

export type AgentCreated = z.infer<typeof AgentCreatedSchema>;
