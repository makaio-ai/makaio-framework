import { z } from 'zod';

/**
 * Get information about a specific agent.
 *
 * Subject: `adapter.getAgent`
 * Type: Request (RPC)
 * Purpose: Returns details for a specific agent, or null if not found.
 */
export const GetAgentSchema = {
  request: z.object({
    /** Target adapter instance ID */
    adapterId: z.string(),
    /** Runtime incarnation that owns the agent and must answer this probe. */
    ownerInstanceId: z.string(),
    /** Agent to retrieve */
    agentId: z.string(),
  }),
  response: z.object({
    agent: z
      .object({
        /** Unique agent identifier */
        agentId: z.string(),
        /** Makaio session ID */
        sessionId: z.string(),
        /** Adapter's provider session ID. May be undefined for idle fork starts. */
        adapterSessionId: z.string().optional(),
      })
      .nullable(),
  }),
};

export type GetAgentRequest = z.infer<typeof GetAgentSchema.request>;
export type GetAgentResponse = z.infer<typeof GetAgentSchema.response>;
