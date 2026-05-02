import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * AI message stream delta received.
 *
 * Subject: `agent.message_delta`
 * Type: Event (fire-and-forget)
 * Emitted when: Streaming message text is received from the AI model
 */
export const MessageDeltaSchema = BaseAgentEventSchema.extend({
  text: z.string(),
});

/**
 * Complete AI message received.
 *
 * Subject: `agent.message`
 * Type: Event (fire-and-forget)
 * Emitted when: A full message is received from the AI model
 */
export const MessageSchema = BaseAgentEventSchema.extend({
  content: z.string(),
});

export type MessageDelta = z.infer<typeof MessageDeltaSchema>;
export type Message = z.infer<typeof MessageSchema>;
