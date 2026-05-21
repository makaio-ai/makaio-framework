import { z } from 'zod';
import { NormalizedMessageInputSchema, MessageOutcomeSchema } from '../../shared/index.js';
import { BaseAgentEventSchema } from './base-event.js';

/**
 * Agent turn started.
 *
 * Subject: `agent.turn.started`
 * Type: Event (fire-and-forget)
 * Emitted when: Agent begins processing a user message (after acknowledgment)
 *
 * Higher-level abstraction over user_message.acknowledged.
 * Consumers who don't need merge/supersede details can subscribe to this.
 */
export const TurnStartedSchema = BaseAgentEventSchema.extend({
  /** The messageId being processed (winner after merge) */
  messageId: z.string(),
  /** Resolved content being sent to provider */
  content: NormalizedMessageInputSchema,
  /** MessageIds that were merged into this turn */
  mergedFrom: z.array(z.string()).optional(),
});

export type TurnStarted = z.infer<typeof TurnStartedSchema>;

/**
 * Agent turn completed.
 *
 * Subject: `agent.turn.completed`
 * Type: Event (fire-and-forget)
 * Emitted when: Agent finishes processing a turn (always paired with agent.turn.started)
 *
 * Fired for ALL outcomes, not just successful completions. Consumers
 * that only care about success should filter on `outcome === 'completed'`.
 * For full outcome details (supersededBy, mergedInto), listen to user_message.completed.
 */
export const TurnCompletedSchema = BaseAgentEventSchema.extend({
  /** The messageId that was processed */
  messageId: z.string(),
  /** The agent's response message (only present when outcome is 'completed') */
  message: z.string().optional(),
  /** The outcome of the turn */
  outcome: MessageOutcomeSchema,
  /** Error message when outcome is 'error' */
  error: z.string().optional(),
});

export type TurnCompleted = z.infer<typeof TurnCompletedSchema>;
