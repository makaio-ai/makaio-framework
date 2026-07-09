import { z } from 'zod';
import { observability } from '@makaio/core';

/**
 * Base agent event fields.
 * All agent events extend this to ensure consistent identification and tracking.
 */
export const BaseAgentEventSchema = z.object({
  /** Unique agent identifier (required) */
  agentId: observability.attribute(z.string(), 'makaio.agent.id'),

  /** Adapter instance identifier (required) */
  adapterId: observability.attribute(z.string(), 'makaio.adapter.id'),

  /** Adapter type name (e.g., 'claude-code') (required) */
  adapterName: observability.attribute(z.string(), 'makaio.adapter.name'),

  /** Makaio session ID (NOT provider's native session ID) */
  sessionId: observability.attribute(z.string(), 'makaio.session.id').optional(),

  /**
   * Provider's native session ID (e.g., Claude conversation ID).
   *
   * Optional because unconfirmed fork sessions have not yet received the
   * provider-assigned child session ID at the time early lifecycle events
   * (e.g. `user_message.sent`) are emitted.  The payload emitter omits
   * the field entirely until the provider confirms the fork.
   */
  adapterSessionId: observability.attribute(z.string(), 'makaio.adapter.session_id').optional(),

  /** User message ID being processed (for correlation with user_message lifecycle events) */
  messageId: observability.attribute(z.string(), 'makaio.message.id').optional(),

  /** Turn ID from the session orchestrator. Optional for backward compatibility. */
  turnId: observability.attribute(z.string(), 'makaio.turn.id').optional(),

  /** Client identifier for the owning application/runtime when known. */
  clientId: observability.attribute(z.string(), 'makaio.client.id').optional(),

  /** Resolved provider configuration identifier when known. */
  providerConfigId: observability.attribute(z.string(), 'makaio.provider.config_id').optional(),

  /** Event occurrence timestamp in epoch milliseconds when known. */
  occurredAt: observability.attribute(z.number(), 'event.occurred_at').optional(),
});

export type BaseAgentEvent = z.infer<typeof BaseAgentEventSchema>;
