import { z } from 'zod';
import type { ContentBlock } from './_acp-types.js';

/**
 * Agent message event schemas for Gemini ACP.
 * Represents assistant message content (streaming).
 * Extracted from upstream sessionUpdateSchema (agent_message_chunk variant).
 *
 * Note: gemini-cli bundles Zod v3, we use v4. Using z.custom<T>() for type safety.
 */

/**
 * Chunk of agent message content (streaming).
 * Matches upstream sessionUpdateSchema exactly:
 * - Uses `sessionUpdate` discriminator (not `type`)
 * - Uses full ContentBlock union (text | image | audio | resource_link | resource)
 */
export type AgentMessageChunkEvent = {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
};

export const AgentMessageChunkEventSchema = z.custom<AgentMessageChunkEvent>(() => true);
