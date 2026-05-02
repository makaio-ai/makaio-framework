import { z } from 'zod';

/**
 * Schema for a text delta within a streaming chunk.
 * Matches Anthropic TextDelta structure.
 */
const TextDeltaSchema = z.object({
  type: z.literal('text_delta'),
  text: z.string(),
});

/**
 * Schema for a thinking/reasoning delta within a streaming chunk.
 * Matches Anthropic ThinkingDelta structure.
 */
const ThinkingDeltaSchema = z.object({
  type: z.literal('thinking_delta'),
  thinking: z.string(),
});

/**
 * Schema for a tool input JSON delta within a streaming chunk.
 * Matches Anthropic InputJSONDelta structure.
 */
const InputJsonDeltaSchema = z.object({
  type: z.literal('input_json_delta'),
  partial_json: z.string(),
});

/**
 * Schema for the content block delta within a streaming chunk.
 * Discriminated union of supported delta types.
 */
const ContentBlockDeltaSchema = z.discriminatedUnion('type', [
  TextDeltaSchema,
  ThinkingDeltaSchema,
  InputJsonDeltaSchema,
]);

/**
 * Schema for streaming chunk event.
 * Based on Anthropic RawContentBlockDeltaEvent structure.
 * @see https://docs.anthropic.com/en/api/messages-streaming
 */
export const ChunkEventSchema = z.object({
  eventType: z.literal('chunk'),
  /** Index of the content block this delta belongs to */
  index: z.number(),
  /** Content delta for this chunk */
  delta: ContentBlockDeltaSchema,
});

export type ChunkEvent = z.infer<typeof ChunkEventSchema>;
