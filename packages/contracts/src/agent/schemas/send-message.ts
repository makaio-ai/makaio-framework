import { z } from 'zod';
import { MessageInputSchema } from '../../shared/index.js';
import { SessionContextSchema } from '../../session/session-context.js';

/**
 * Send a message to an existing agent.
 *
 * Subject: `agent.sendMessage`
 * Type: Request (RPC)
 * Purpose: Sends a message to an existing agent instance (errors if agent doesn't exist)
 */
export const SendMessageSchema = {
  request: z.object({
    agentId: z.string(),
    adapterId: z.string(),
    message: MessageInputSchema,
    deliveryMode: z.enum(['enqueue', 'immediate']).optional(),
    /**
     * Message ID from orchestrator.
     * If provided, this ID flows through the entire processing chain,
     * enabling correlation between user messages and agent responses.
     * If omitted, the adapter generates its own ID.
     */
    messageId: z.string().optional(),
    /**
     * Session ID for hook context enrichment.
     * Enables PreUserMessage hooks to look up session, history, and project.
     * Optional for backwards compatibility - hooks work without it but
     * return empty enrichments.
     */
    sessionId: z.string().optional(),
    /** Turn ID for correlation with session turns. */
    turnId: z.string().optional(),
    /**
     * Session context with curated messageHistory and decision signals.
     * Contains curated messageHistory and flags for native resume decision.
     */
    sessionContext: SessionContextSchema.optional(),
    /**
     * JSON Schema for structured output.
     * When present and supported by the adapter, the model response
     * is constrained to this schema.
     */
    responseSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  response: z.object({
    messageId: z.string(),
  }),
};

export type SendMessageRequest = z.infer<typeof SendMessageSchema.request>;
export type SendMessageResponse = z.infer<typeof SendMessageSchema.response>;
