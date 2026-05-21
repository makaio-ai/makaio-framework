import { z } from 'zod';
import { BaseAdapterEventSchema } from './base-event.js';

/**
 * Session-level cumulative usage metrics.
 *
 * Subject: `adapter.session.usage`
 * Type: Event (fire-and-forget)
 * Emitted when: Session usage totals are updated (after each API call)
 *
 * This event contains running totals for the entire session/conversation.
 * For per-call delta metrics, see `agent.usage`.
 */
export const SessionUsageSchema = BaseAdapterEventSchema.extend({
  sessionId: z.string(),
  adapterSessionId: z.string(),
  totalInputTokens: z.number(),
  totalOutputTokens: z.number(),
  totalCalls: z.number(),
});

export type SessionUsage = z.infer<typeof SessionUsageSchema>;
