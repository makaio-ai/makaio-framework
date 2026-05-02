import { z } from 'zod';
import { BaseSdkMessageWithParentToolSchema } from './base.js';
import { BetaMessageSchema } from './beta-message.js';

/**
 * SDK Assistant Message schema
 * Wraps a BetaMessage with SDK metadata (uuid, session_id, parent_tool_use_id)
 * @see SDKAssistantMessage from \@anthropic-ai/claude-agent-sdk
 */
export const SDKAssistantMessageSchema = BaseSdkMessageWithParentToolSchema.extend({
  /** Message type discriminator */
  type: z.literal('assistant'),

  /** The API assistant message containing the content */
  message: BetaMessageSchema,
});

export type SDKAssistantMessage = z.infer<typeof SDKAssistantMessageSchema>;
