import { z } from 'zod';
export {
  JsonValueSchema,
  JsonObjectSchema,
  JsonObjectContractSchema,
  JsonSchemaRecordSchema,
  type JsonValue,
} from './json-value.js';

/**
 * Content source for binary data or external resources.
 * Supports either base64-encoded data or URL-based content.
 *
 * Invariant: the `base64` branch requires a known MIME type. Staging utilities
 * always populate `mimeType` before a source reaches the message bus, so callers
 * that construct a `base64` source must always provide it.
 * The `url` branch leaves `mimeType` optional because remote URLs may not have
 * a known content type upfront.
 */
export const ContentSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('base64'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('url'),
    url: z.string(),
    mimeType: z.string().optional(),
  }),
]);

/**
 * Attachment type enumeration.
 * Specifies whether the attachment is a file or directory.
 */
const AttachmentTypeSchema = z.enum(['file', 'directory']);

/**
 * Message block representing different types of content.
 * Supports text, images, documents, file attachments, reasoning, tool calls, and tool outputs.
 */
export const MessageBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    content: z.string(),
  }),
  z.object({
    type: z.literal('image'),
    source: ContentSourceSchema,
  }),
  z.object({
    type: z.literal('document'),
    source: ContentSourceSchema,
  }),
  z.object({
    type: z.literal('attachment'),
    /** Original filename with extension (e.g. "api-spec.yaml") — for display and type inference */
    fileName: z.string(),
    /** Server-side file path — always populated before message reaches adapters */
    filePath: z.string(),
    /** Inline content — base64 for binary, raw string for text */
    source: ContentSourceSchema,
    /** Optional human-readable display name override */
    displayName: z.string().optional(),
    /** Whether the attachment is a file or directory */
    attachmentType: AttachmentTypeSchema,
  }),
  z.object({
    type: z.literal('reasoning'),
    content: z.string(),
    /** Optional provider/runtime metadata for reasoning blocks. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('tool_call'),
    toolCallId: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('tool_output'),
    toolCallId: z.string(),
    output: z.string(),
    isError: z.boolean().optional(),
  }),
]);

/**
 * Message role enumeration.
 * Identifies the sender of the message in a conversation.
 */
const MessageRoleSchema = z.enum(['user', 'assistant', 'system']);

/**
 * Structured message with role and content blocks.
 * Blocks can be a single block or an array of blocks.
 */
export const MessageSchema = z.object({
  role: MessageRoleSchema.optional(),
  blocks: z.union([MessageBlockSchema, z.array(MessageBlockSchema)]),
});

/**
 * Message input type.
 * Accepts either a simple string or a structured Message object.
 */
export const MessageInputSchema = z.union([z.string(), MessageSchema]);

export const SendMessageResultInnerResultSchema = z.object({
  message: z.string().optional(),
});

/**
 * Possible outcomes for a user message lifecycle.
 */
export const MessageOutcomeSchema = z.enum([
  'completed', // Processing finished successfully
  'superseded', // Interrupted by replace/immediate mode
  'merged', // Folded into another message (last wins)
  'cancelled', // Explicitly canceled
  'error', // Processing failed
  'rejected', // Immediate message was rejected (arrived too late)
]);

export const SendMessageResultSchema = z.object({
  messageId: z.string(),
  result: SendMessageResultInnerResultSchema.optional(),
  error: z.string().optional(),
  outcome: MessageOutcomeSchema,
});

export const MessageDeliveryModeSchema = z.enum(['enqueue', 'immediate', 'replace']);

/**
 * System prompt configuration for agent sessions.
 *
 * Supports two modes:
 * - `string`: Replace/set the entire system prompt
 * - `{ mode: 'append', content: string }`: Append to adapter's default system prompt
 *
 * The append mode is useful for adding context-specific instructions (e.g., messageHistory
 * interpretation) without overriding the adapter's base configuration.
 * @example
 * ```typescript
 * // Replace entirely
 * systemPrompt: 'You are a helpful assistant.'
 *
 * // Append to existing
 * systemPrompt: {
 *   mode: 'append',
 *   content: 'You are naturally continuing a conversation with user.',
 * }
 * ```
 */
export const SystemPromptSchema = z.union([
  z.string(),
  z.object({
    mode: z.literal('append'),
    content: z.string(),
  }),
]);

/**
 * Schema for normalized message input.
 * Used for user messages with full structure including role and content blocks.
 */
export const NormalizedMessageInputSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  blocks: z.array(MessageBlockSchema),
  message: z.string().optional(),
});

export type NormalizedMessageInput = z.infer<typeof NormalizedMessageInputSchema>;

/**
 * Inferred TypeScript types from schemas.
 */
export type ContentSource = z.infer<typeof ContentSourceSchema>;
export type MessageBlock = z.infer<typeof MessageBlockSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type MessageInput = z.infer<typeof MessageInputSchema>;

export type SendMessageResult = z.infer<typeof SendMessageResultSchema>;
export type SendMessageResultInnerResult = z.infer<typeof SendMessageResultInnerResultSchema>;
export type MessageOutcome = z.infer<typeof MessageOutcomeSchema>;
export type MessageDeliveryMode = z.infer<typeof MessageDeliveryModeSchema>;
export type SystemPrompt = z.infer<typeof SystemPromptSchema>;

/**
 * Runtime error categories for adapter failures.
 * Used to classify errors during agent execution for fallback/retry logic.
 *
 * Note: The 'all' category exists in VirtualModelErrorCategorySchema but is excluded here
 * as it's only used for fallback configuration, not runtime error classification.
 */
export const ERROR_CATEGORIES = ['rate_limit', 'auth', 'model_unavailable', 'quota_exceeded'] as const;
export const ErrorCategorySchema = z.enum(ERROR_CATEGORIES);

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export {
  ResponseSchemaDescriptorSchema,
  ResponseSchemaNameSchema,
  StructuredOutputValidationErrorSchema,
  StructuredOutputValidationSchema,
  StructuredOutputValidationStatusSchema,
  type ResponseSchemaDescriptor,
  type ResponseSchemaName,
  type StructuredOutputValidation,
  type StructuredOutputValidationError,
  type StructuredOutputValidationStatus,
} from './response-schema.js';
export { EntityUIConfigSchema, FieldOptionSchema, FieldOverrideSchema } from './ui-config.js';
export type {
  BaseFieldDefinition,
  BuiltinWidget,
  CustomFieldDefinition,
  EntityUIConfig,
  FieldDefinition,
  FieldOption,
  FieldOverride,
  FieldType,
  FieldWidget,
  FormFieldProps,
  PluginWidgetRegistry,
  StandardFieldDefinition,
} from './ui-config.js';
