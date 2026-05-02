import { z } from 'zod';
import { BaseAgentEventSchema } from './base-event.js';
import { MessageOutcomeSchema } from '../../shared/index.js';

/**
 * User message lifecycle completed.
 *
 * Subject: `agent.user_message.completed`
 * Type: Event (fire-and-forget)
 * Emitted when: A user message's lifecycle ends (any outcome)
 *
 * Every messageId from user_message.sent will eventually get a corresponding
 * user_message.completed event with an explicit outcome.
 *
 * For persistence/reconstruction:
 * - `completed`: Normal flow, agent.complete also emitted
 * - `superseded`: Partial response may exist, check supersededBy
 * - `merged`: Content folded into mergedInto message
 * - `cancelled`: No response expected
 * - `error`: Check agent.error for details
 */
export const UserMessageCompletedSchema = BaseAgentEventSchema.extend({
  messageId: z.string(),
  outcome: MessageOutcomeSchema,
  /** Present when outcome='superseded': the messageId that replaced this one */
  supersededBy: z.string().optional(),
  /** Present when outcome='merged': the messageId this was folded into */
  mergedInto: z.string().optional(),
  /** Optional error message when outcome='error' */
  error: z.string().optional(),
});

export type UserMessageCompleted = z.infer<typeof UserMessageCompletedSchema>;
