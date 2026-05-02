import { z } from 'zod';

/**
 * RPC subject for validating a mid-session model swap.
 *
 * Subject: `agent.validateModelChange`
 * Type: Request (RPC)
 * Direction: framework → host
 *
 * The framework adapter emits this before replacing a connector. The host
 * layer (or any registered handler) decides whether the change should proceed
 * and whether to request an edit-history fork. If no handler is registered
 * (OSS / headless mode) the framework treats the change as auto-approved.
 */
export const ValidateModelChangeSchema = {
  request: z.object({
    /** Stable identifier of the agent whose connector is about to be swapped. */
    agentId: z.string(),
    /** Model identifier currently active on the agent. */
    currentModel: z.string(),
    /** Model identifier the agent is switching to. */
    nextModel: z.string(),
  }),
  response: z.object({
    /** Whether the model change should proceed. */
    proceed: z.boolean(),
    /**
     * When `true`, the host layer wants the session to fork with an edit-
     * history window before the connector swap completes.
     */
    requestEditHistory: z.boolean().optional(),
  }),
};

export type ValidateModelChangeRequest = z.infer<typeof ValidateModelChangeSchema.request>;
export type ValidateModelChangeResponse = z.infer<typeof ValidateModelChangeSchema.response>;
