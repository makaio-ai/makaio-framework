import { z } from 'zod';
import { BaseSdkMessageWithParentToolSchema } from './base.js';
import { BetaContentBlockSchema } from './content-blocks/index.js';
import { BetaTextCitationSchema, BetaUsageSchema } from './common/index.js';

/**
 * Inner event schemas (without SDK envelope)
 */
export const MessageStartEventSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
  }),
});

export const MessageDeltaEventSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    container: z
      .object({
        id: z.string(),
        expires_at: z.string(),
      })
      .nullable()
      .optional(),
  }),
  usage: BetaUsageSchema,
});

export const MessageStopEventSchema = z.object({
  type: z.literal('message_stop'),
});

/**
 * Content block start event
 * @see BetaRawContentBlockStartEvent from \@anthropic-ai/sdk
 */
export const ContentBlockStartEventSchema = z.object({
  type: z.literal('content_block_start'),
  index: z.number(),
  /** Discriminated union of all Beta output content block types */
  content_block: BetaContentBlockSchema,
});

export const ContentBlockDeltaEventSchema = z.object({
  type: z.literal('content_block_delta'),
  index: z.number(),
  delta: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('text_delta'),
      text: z.string(),
    }),
    z.object({
      type: z.literal('thinking_delta'),
      thinking: z.string(),
    }),
    z.object({
      type: z.literal('input_json_delta'),
      partial_json: z.string(),
    }),
    z.object({
      type: z.literal('citations_delta'),
      citation: BetaTextCitationSchema,
    }),
    z.object({
      type: z.literal('signature_delta'),
      signature: z.string(),
    }),
  ]),
});

export const ContentBlockStopEventSchema = z.object({
  type: z.literal('content_block_stop'),
  index: z.number(),
});

/**
 * Discriminated union of all stream event types (inner event objects)
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  MessageStartEventSchema,
  MessageDeltaEventSchema,
  MessageStopEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockDeltaEventSchema,
  ContentBlockStopEventSchema,
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * SDK Stream Event Message schema with envelope
 * Wraps stream events with SDK metadata (uuid, session_id, parent_tool_use_id)
 */
export const SDKStreamEventMessageSchema = BaseSdkMessageWithParentToolSchema.extend({
  type: z.literal('stream_event'),
  event: StreamEventSchema,
});

export type SDKStreamEventMessage = z.infer<typeof SDKStreamEventMessageSchema>;
