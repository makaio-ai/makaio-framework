import { z } from 'zod';
import { MessageDeliveryModeSchema, NormalizedMessageInputSchema } from '../../shared/index.js';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * User message sent to agent.
 *
 * Subject: `agent.user_message.sent`
 * Type: Event (fire-and-forget)
 * Emitted when: A user message is enqueued for processing
 *
 * Captures all user intent including messages that may be superseded.
 * For persistence, this is the source of truth for user input.
 */
export const UserMessageSentSchema = BaseAgentEventSchema.extend({
  messageId: z.string(),
  content: NormalizedMessageInputSchema,
  deliveryMode: MessageDeliveryModeSchema,
});

export type UserMessageSent = z.infer<typeof UserMessageSentSchema>;
