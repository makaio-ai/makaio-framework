import { z } from 'zod';

/**
 * List active agents for an adapter.
 *
 * Subject: `adapter.listAgents`
 * Type: Request (RPC)
 * Purpose: Returns all active agents managed by the specified adapter.
 */
export const ListAgentsSchema = {
  request: z.object({
    /** Target adapter instance ID */
    adapterId: z.string(),
  }),
  response: z.object({
    agents: z.array(
      z.object({
        /** Unique agent identifier */
        agentId: z.string(),
        /** Makaio session ID */
        sessionId: z.string(),
        /** Adapter's provider session ID. May be undefined for idle fork starts. */
        adapterSessionId: z.string().optional(),
      }),
    ),
  }),
};

export type ListAgentsRequest = z.infer<typeof ListAgentsSchema.request>;
export type ListAgentsResponse = z.infer<typeof ListAgentsSchema.response>;
