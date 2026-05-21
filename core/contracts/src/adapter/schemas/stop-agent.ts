import { z } from 'zod';

/**
 * Stop and dispose an agent.
 *
 * Subject: `adapter.stopAgent`
 * Type: Request (RPC)
 * Purpose: Aborts the agent and removes it from the adapter's tracking.
 */
export const StopAgentSchema = {
  request: z.object({
    /** Target adapter instance ID */
    adapterId: z.string(),
    /** Agent to stop */
    agentId: z.string(),
  }),
  response: z.object({
    /** Whether the agent was found and stopped */
    success: z.boolean(),
  }),
};

export type StopAgentRequest = z.infer<typeof StopAgentSchema.request>;
export type StopAgentResponse = z.infer<typeof StopAgentSchema.response>;
