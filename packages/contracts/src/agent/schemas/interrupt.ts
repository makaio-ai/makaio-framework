import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Request to interrupt the active agent turn.
 *
 * Subject: `agent.interrupt`
 * Type: Request/Response
 * Sent when: Caller wants the connector to stop current processing and return control.
 * Handler: AIAgent delegates to the active connector's `interrupt()` implementation.
 */
export const AgentInterruptSchema = {
  request: BaseAgentEventSchema,
  response: z.discriminatedUnion('success', [
    z.object({
      /** Interrupt request was accepted by the connector. */
      success: z.literal(true),
    }),
    z.object({
      /** Interrupt request was rejected by the connector. */
      success: z.literal(false),
      /** Non-empty reason for failure. */
      reason: z.string().min(1),
    }),
  ]),
};

export type AgentInterruptRequest = z.infer<typeof AgentInterruptSchema.request>;
export type AgentInterruptResponse = z.infer<typeof AgentInterruptSchema.response>;
