import { z } from 'zod';
import type { ContentBlock } from './_acp-types.js';

/**
 * User message event schema for Gemini ACP.
 * Represents user message content chunks from the upstream session.
 */

/**
 * Chunk of user message content.
 * Extracted from upstream sessionUpdateSchema where sessionUpdate === 'user_message_chunk'.
 * Content can be text, image, audio, resource_link, or resource.
 */
const ContentBlockSchema = z.custom<ContentBlock>(() => true);

export const UserMessageChunkEventSchema = z.object({
  sessionUpdate: z.literal('user_message_chunk'),
  content: ContentBlockSchema,
});

export type UserMessageChunkEvent = z.infer<typeof UserMessageChunkEventSchema>;
