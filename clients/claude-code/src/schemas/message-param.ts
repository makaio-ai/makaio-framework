import { z } from 'zod';
import { BetaContentBlockParamSchema } from './content-blocks/index.js';

/**
 * Message parameter schema matching SDK MessageParam interface
 * Used for both user and assistant messages in the input messages array
 * @see BetaMessageParam from \@anthropic-ai/sdk
 */
export const MessageParamSchema = z.object({
  /**
   * Conversational role of the message
   */
  role: z.enum(['user', 'assistant']),

  /**
   * Message content - can be a simple string or array of content blocks
   *
   * Using a `string` for `content` is shorthand for an array of one content
   * block of type `"text"`.
   */
  content: z.union([z.string(), z.array(BetaContentBlockParamSchema)]),
});

export type MessageParam = z.infer<typeof MessageParamSchema>;
