import { z } from 'zod';

/**
 * Query effective capabilities of a running agent.
 *
 * Subject: `agent.getCapabilities`
 * Type: Request (RPC)
 * Purpose: Returns capabilities based on the agent's current model
 */
export const AgentGetCapabilitiesSchema = {
  request: z.object({
    /** Agent ID to query capabilities for */
    agentId: z.string(),
  }),
  response: z.object({
    /** Effective capabilities for this agent's current model */
    capabilities: z.array(z.string()),
    /** Native tools available to this agent */
    nativeTools: z.array(z.string()),
    /** Current model (informational) */
    model: z.string().optional(),
  }),
};

export type AgentGetCapabilitiesRequest = z.infer<typeof AgentGetCapabilitiesSchema.request>;
export type AgentGetCapabilitiesResponse = z.infer<typeof AgentGetCapabilitiesSchema.response>;
