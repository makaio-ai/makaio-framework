import { z } from 'zod';
import type { ContentBlock } from './_acp-types.js';

/**
 * Agent thought/reasoning event schemas for Gemini ACP.
 * Represents streaming reasoning/thinking content.
 *
 * Matches upstream sessionUpdateSchema variant exactly:
 * - Uses `sessionUpdate` field (not `type`)
 * - Uses full ContentBlock (text | image | audio | resource_link | resource)
 *
 * Note: gemini-cli bundles Zod v3, we use v4. Using z.custom<T>() for type safety.
 */

/**
 * Chunk of agent reasoning/thinking content (streaming).
 * Extracted from upstream sessionUpdateSchema agent_thought_chunk variant.
 */
export type AgentThoughtChunkEvent = {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
  sessionId: string;
};

export const AgentThoughtChunkEventSchema = z.custom<AgentThoughtChunkEvent>(() => true);
