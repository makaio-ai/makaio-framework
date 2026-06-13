import { z } from 'zod';

/**
 * Rehydrate an agent by swapping its connector.
 *
 * Subject: `adapter.rehydrateAgent`
 * Type: Request (RPC)
 * Purpose: Allows the orchestrator to swap an agent's connector (e.g., after a crash)
 * instead of killing and recreating the agent. This preserves the agent's
 * identity and session state while replacing the underlying execution context.
 *
 * The adapter will:
 * 1. Stop the existing connector for the specified agent
 * 2. Create a new connector with optional config overrides (cwd, model)
 * 3. Wire the new connector to the existing agent instance
 *
 * Success is implicit. Errors are thrown if:
 * - Agent not found
 * - Adapter not found
 * - Connector swap fails
 * @param adapterId - Target adapter instance ID
 * @param agentId - Agent to rehydrate
 * @param cwd - Optional working directory override for new connector
 * @param model - Optional model override for new connector
 * @param adapterSessionId - Optional persisted native session ID for resume-capable connectors
 */
export const RehydrateAgentSchema = {
  request: z.object({
    /** Target adapter instance ID */
    adapterId: z.string(),

    /** Agent to rehydrate */
    agentId: z.string(),

    /** Optional working directory override for new connector */
    cwd: z.string().optional(),

    /** Optional model override for new connector (adapter-specific, e.g., 'sonnet', 'opus') */
    model: z.string().optional(),

    /** Optional persisted native session ID for resume-capable connectors */
    adapterSessionId: z.string().optional(),
  }),

  /** Empty response - success is implicit, errors throw */
  response: z.object({}),
};

export type RehydrateAgentRequest = z.infer<typeof RehydrateAgentSchema.request>;
export type RehydrateAgentResponse = z.infer<typeof RehydrateAgentSchema.response>;
