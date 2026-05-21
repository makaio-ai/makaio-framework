import { z } from 'zod';

/**
 * Base agent event fields.
 * All agent events extend this to ensure consistent identification and tracking.
 */
export const BaseAgentEventSchema = z.object({
  /** Unique agent identifier (required) */
  agentId: z.string(),

  /** Adapter instance identifier (required) */
  adapterId: z.string(),

  /** Adapter type name (e.g., 'claude-code') (required) */
  adapterName: z.string(),

  /** Makaio session ID (NOT provider's native session ID) */
  sessionId: z.string().optional(),

  /** Provider's native session ID (e.g., Claude conversation ID) */
  adapterSessionId: z.string(),

  /** User message ID being processed (for correlation with user_message lifecycle events) */
  messageId: z.string().optional(),

  /** Turn ID from the session orchestrator. Optional for backward compatibility. */
  turnId: z.string().optional(),

  /** Client identifier for the owning application/runtime when known. */
  clientId: z.string().optional(),

  /** Resolved provider configuration identifier when known. */
  providerConfigId: z.string().optional(),

  /** Event occurrence timestamp in epoch milliseconds when known. */
  occurredAt: z.number().optional(),
});

export type BaseAgentEvent = z.infer<typeof BaseAgentEventSchema>;
