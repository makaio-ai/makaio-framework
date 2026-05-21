import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * User message acknowledged by agent (processing started).
 *
 * Subject: `agent.user_message.acknowledged`
 * Type: Event (fire-and-forget)
 * Emitted when: SDK begins processing a user message
 *
 * Marks the turn start boundary at agent level.
 * If messages were merged, `mergedFrom` contains the messageIds that were
 * folded into this message (their content was combined).
 */
export const UserMessageAcknowledgedSchema = BaseAgentEventSchema.extend({
  messageId: z.string(),
  /** MessageIds that were merged into this message (last one wins semantics) */
  mergedFrom: z.array(z.string()).optional(),
});

export type UserMessageAcknowledged = z.infer<typeof UserMessageAcknowledgedSchema>;
