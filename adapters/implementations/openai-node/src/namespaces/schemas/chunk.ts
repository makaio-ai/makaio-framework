import { z } from 'zod';

/**
 * Schema for tool call deltas within streaming chunks.
 * Matches OpenAI ChatCompletionChunk.Choice.Delta.ToolCall structure.
 */
const ToolCallDeltaSchema = z.object({
  index: z.number(),
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

/**
 * Schema for streaming delta within a choice.
 * Matches OpenAI ChatCompletionChunk.Choice.Delta structure.
 */
const DeltaSchema = z.object({
  content: z.string().nullish(),
  role: z.enum(['assistant', 'user', 'system', 'tool', 'developer']).optional(),
  refusal: z.string().nullish(),
  tool_calls: z.array(ToolCallDeltaSchema).optional(),
});

/**
 * Schema for a single choice in a streaming chunk.
 * Matches OpenAI ChatCompletionChunk.Choice structure.
 */
const ChoiceSchema = z.object({
  delta: DeltaSchema,
  index: z.number(),
  finish_reason: z.enum(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']).nullable(),
  logprobs: z.unknown().nullish(),
});

/**
 * Schema for streaming chunk event.
 * Based on OpenAI ChatCompletionChunk structure.
 * @see https://platform.openai.com/docs/api-reference/chat/streaming
 */
export const ChunkEventSchema = z.object({
  eventType: z.literal('chunk'),
  /** Unique identifier for the chat completion */
  id: z.string(),
  /** Array of choices (typically one for streaming) */
  choices: z.array(ChoiceSchema),
  /** Unix timestamp when the chunk was created */
  created: z.number(),
  /** Model that generated the chunk */
  model: z.string(),
  /** Object type identifier */
  object: z.literal('chat.completion.chunk'),
  /** Service tier used for processing */
  service_tier: z.enum(['auto', 'default', 'flex', 'scale', 'priority']).nullish(),
  /** System fingerprint for determinism tracking */
  system_fingerprint: z.string().optional(),
});

export type ChunkEvent = z.infer<typeof ChunkEventSchema>;
