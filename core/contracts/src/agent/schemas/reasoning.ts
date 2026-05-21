import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * AI reasoning stream delta received.
 *
 * Subject: `agent.reasoning_delta`
 * Type: Event (fire-and-forget)
 * Emitted when: Streaming reasoning content is received from the AI model
 */
export const ReasoningDeltaSchema = BaseAgentEventSchema.extend({
  content: z.string(),
});

/**
 * Complete AI reasoning block received.
 *
 * Subject: `agent.reasoning`
 * Type: Event (fire-and-forget)
 * Emitted when: A full reasoning/thinking block is received from the AI model
 */
export const ReasoningSchema = BaseAgentEventSchema.extend({
  content: z.string(),
});

export type ReasoningDelta = z.infer<typeof ReasoningDeltaSchema>;
export type Reasoning = z.infer<typeof ReasoningSchema>;
