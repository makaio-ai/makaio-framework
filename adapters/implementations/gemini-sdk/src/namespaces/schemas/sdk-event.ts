import { z } from 'zod';

/**
 * Zod schemas for Gemini SDK raw stream events.
 *
 * These schemas validate the native `ServerGeminiStreamEvent` types from
 * `@google/gemini-cli-core/dist/src/core/turn.d.ts`, replacing the previous
 * ACP-based event schemas.
 *
 * Event types correspond to `GeminiEventType` enum values and are dispatched
 * during agent turn execution via the SDK's `Turn.run()` async generator.
 */

/**
 * Enum matching SDK's GeminiEventType values.
 * Only includes event types currently handled by our adapter.
 */
export enum GeminiEventType {
  Content = 'content',
  ToolCallRequest = 'tool_call_request',
  ToolCallResponse = 'tool_call_response',
  ToolCallConfirmation = 'tool_call_confirmation',
  UserCancelled = 'user_cancelled',
  Error = 'error',
  ChatCompressed = 'chat_compressed',
  Thought = 'thought',
  MaxSessionTurns = 'max_session_turns',
  Finished = 'finished',
  LoopDetected = 'loop_detected',
  Citation = 'citation',
  Retry = 'retry',
  ContextWindowWillOverflow = 'context_window_will_overflow',
  InvalidStream = 'invalid_stream',
  ModelInfo = 'model_info',
  AgentExecutionStopped = 'agent_execution_stopped',
  AgentExecutionBlocked = 'agent_execution_blocked',
}

/**
 * ThoughtSummary from SDK utils/thoughtUtils.
 * Represents parsed agent reasoning/thinking content.
 */
export const thoughtSummarySchema = z.object({
  subject: z.string(),
  description: z.string(),
});

/**
 * ToolCallRequestInfo from SDK.
 * Contains tool invocation details requested by the model.
 */
export const toolCallRequestInfoSchema = z.object({
  callId: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
  isClientInitiated: z.boolean(),
  prompt_id: z.string(),
});

/**
 * StructuredError from SDK.
 * Standard error object with optional HTTP status.
 */
export const structuredErrorSchema = z.object({
  message: z.string(),
  status: z.number().optional(),
});

/**
 * GeminiErrorEventValue from SDK.
 * Wrapper for error events containing structured error details.
 */
export const geminiErrorEventValueSchema = z.object({
  error: z.unknown(),
});

/**
 * FinishReason from \@google/genai.
 * Indicates why content generation stopped.
 */
export const finishReasonSchema = z.enum([
  'FINISH_REASON_UNSPECIFIED',
  'STOP',
  'MAX_TOKENS',
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'OTHER',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY',
  'UNEXPECTED_TOOL_CALL',
  'IMAGE_PROHIBITED_CONTENT',
  'NO_IMAGE',
  'IMAGE_RECITATION',
  'IMAGE_OTHER',
]);

/**
 * GenerateContentResponseUsageMetadata from \@google/genai.
 * Token usage statistics for the generation request.
 */
export const usageMetadataSchema = z.object({
  cachedContentTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  promptTokenCount: z.number().optional(),
  thoughtsTokenCount: z.number().optional(),
  toolUsePromptTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional(),
  /** Billing tier (e.g., 'PROVISIONED_THROUGHPUT', 'ON_DEMAND') */
  trafficType: z.string().optional(),
  // Note: Detailed modality breakdown fields omitted for brevity
  // Can be added if needed: cacheTokensDetails, candidatesTokensDetails, etc.
});

/**
 * GeminiFinishedEventValue from SDK.
 * Contains completion reason and token usage metadata.
 */
export const geminiFinishedEventValueSchema = z.object({
  reason: finishReasonSchema.optional(),
  usageMetadata: usageMetadataSchema.optional(),
});

/**
 * Content event: Streaming text content from model response.
 */
export const serverGeminiContentEventSchema = z.object({
  type: z.literal(GeminiEventType.Content),
  value: z.string(),
  traceId: z.string().optional(),
});

/**
 * Thought event: Agent reasoning/thinking content (structured).
 */
export const serverGeminiThoughtEventSchema = z.object({
  type: z.literal(GeminiEventType.Thought),
  value: thoughtSummarySchema,
  traceId: z.string().optional(),
});

/**
 * Tool call request event: Model requesting tool execution.
 */
export const serverGeminiToolCallRequestEventSchema = z.object({
  type: z.literal(GeminiEventType.ToolCallRequest),
  value: toolCallRequestInfoSchema,
});

/**
 * Error event: Execution or model errors during turn.
 */
export const serverGeminiErrorEventSchema = z.object({
  type: z.literal(GeminiEventType.Error),
  value: geminiErrorEventValueSchema,
});

/**
 * Finished event: Turn completed with reason and usage stats.
 */
export const serverGeminiFinishedEventSchema = z.object({
  type: z.literal(GeminiEventType.Finished),
  value: geminiFinishedEventValueSchema,
});

/**
 * User cancelled event: User aborted the turn.
 */
export const serverGeminiUserCancelledEventSchema = z.object({
  type: z.literal(GeminiEventType.UserCancelled),
});

/**
 * Citation event: Citation metadata from model response.
 */
export const serverGeminiCitationEventSchema = z.object({
  type: z.literal(GeminiEventType.Citation),
  value: z.string(),
});

/**
 * Loop detected event: SDK detected infinite tool call loop.
 */
export const serverGeminiLoopDetectedEventSchema = z.object({
  type: z.literal(GeminiEventType.LoopDetected),
});

/**
 * Max session turns event: Session reached turn limit.
 */
export const serverGeminiMaxSessionTurnsEventSchema = z.object({
  type: z.literal(GeminiEventType.MaxSessionTurns),
});

/**
 * Retry event: SDK retrying after transient failure.
 */
export const serverGeminiRetryEventSchema = z.object({
  type: z.literal(GeminiEventType.Retry),
});

/**
 * Context window overflow event: Request will exceed context limit.
 */
export const serverGeminiContextWindowWillOverflowEventSchema = z.object({
  type: z.literal(GeminiEventType.ContextWindowWillOverflow),
  value: z.object({
    estimatedRequestTokenCount: z.number(),
    remainingTokenCount: z.number(),
  }),
});

/**
 * Invalid stream event: SDK received malformed stream data.
 */
export const serverGeminiInvalidStreamEventSchema = z.object({
  type: z.literal(GeminiEventType.InvalidStream),
});

/**
 * Model info event: Information about the model being used.
 */
export const serverGeminiModelInfoEventSchema = z.object({
  type: z.literal(GeminiEventType.ModelInfo),
  value: z.string(),
});

/**
 * Agent execution stopped event: Agent execution was stopped.
 */
export const serverGeminiAgentExecutionStoppedEventSchema = z.object({
  type: z.literal(GeminiEventType.AgentExecutionStopped),
  value: z.object({
    reason: z.string(),
  }),
});

/**
 * Agent execution blocked event: Agent execution was blocked.
 */
export const serverGeminiAgentExecutionBlockedEventSchema = z.object({
  type: z.literal(GeminiEventType.AgentExecutionBlocked),
  value: z.object({
    reason: z.string(),
  }),
});

/**
 * CompressionStatus enum from SDK.
 * Indicates the result of chat history compression.
 */
export enum CompressionStatus {
  COMPRESSED = 1,
  COMPRESSION_FAILED_INFLATED_TOKEN_COUNT = 2,
  COMPRESSION_FAILED_TOKEN_COUNT_ERROR = 3,
  NOOP = 4,
}

/**
 * ChatCompressionInfo from SDK.
 * Contains compression statistics when chat history is compressed.
 */
export const chatCompressionInfoSchema = z.object({
  originalTokenCount: z.number(),
  newTokenCount: z.number(),
  compressionStatus: z.nativeEnum(CompressionStatus),
});

/**
 * Chat compressed event: Chat history was compressed.
 */
export const serverGeminiChatCompressedEventSchema = z.object({
  type: z.literal(GeminiEventType.ChatCompressed),
  value: chatCompressionInfoSchema.nullable(),
});

/**
 * ToolCallResponseInfo from SDK.
 * Contains tool execution results and metadata.
 */
export const toolCallResponseInfoSchema = z.object({
  callId: z.string(),
  responseParts: z.array(z.unknown()), // Part[] from @google/genai
  resultDisplay: z.unknown().optional(), // ToolResultDisplay
  error: z.instanceof(Error).optional(),
  errorType: z.string().optional(), // ToolErrorType
  outputFile: z.string().optional(),
  contentLength: z.number().optional(),
});

/**
 * Tool call response event: Tool execution completed.
 */
export const serverGeminiToolCallResponseEventSchema = z.object({
  type: z.literal(GeminiEventType.ToolCallResponse),
  value: toolCallResponseInfoSchema,
});

/**
 * ServerToolCallConfirmationDetails from SDK.
 * Contains tool call confirmation details.
 */
export const serverToolCallConfirmationDetailsSchema = z.object({
  request: toolCallRequestInfoSchema,
  details: z.unknown(), // ToolCallConfirmationDetails from SDK
});

/**
 * Tool call confirmation event: Tool call requires user confirmation.
 */
export const serverGeminiToolCallConfirmationEventSchema = z.object({
  type: z.literal(GeminiEventType.ToolCallConfirmation),
  value: serverToolCallConfirmationDetailsSchema,
});

/**
 * Discriminated union of all SDK stream events.
 * Use this schema to validate any event from `Turn.run()` generator.
 */
export const serverGeminiStreamEventSchema = z.discriminatedUnion('type', [
  serverGeminiContentEventSchema,
  serverGeminiThoughtEventSchema,
  serverGeminiToolCallRequestEventSchema,
  serverGeminiToolCallResponseEventSchema,
  serverGeminiToolCallConfirmationEventSchema,
  serverGeminiChatCompressedEventSchema,
  serverGeminiErrorEventSchema,
  serverGeminiFinishedEventSchema,
  serverGeminiUserCancelledEventSchema,
  serverGeminiCitationEventSchema,
  serverGeminiLoopDetectedEventSchema,
  serverGeminiMaxSessionTurnsEventSchema,
  serverGeminiRetryEventSchema,
  serverGeminiContextWindowWillOverflowEventSchema,
  serverGeminiInvalidStreamEventSchema,
  serverGeminiModelInfoEventSchema,
  serverGeminiAgentExecutionStoppedEventSchema,
  serverGeminiAgentExecutionBlockedEventSchema,
]);

/**
 * Type-safe inferred types from Zod schemas
 */
export type ThoughtSummary = z.infer<typeof thoughtSummarySchema>;
export type ToolCallRequestInfo = z.infer<typeof toolCallRequestInfoSchema>;
export type ToolCallResponseInfo = z.infer<typeof toolCallResponseInfoSchema>;
export type StructuredError = z.infer<typeof structuredErrorSchema>;
export type GeminiErrorEventValue = z.infer<typeof geminiErrorEventValueSchema>;
export type GeminiFinishedEventValue = z.infer<typeof geminiFinishedEventValueSchema>;
export type ChatCompressionInfo = z.infer<typeof chatCompressionInfoSchema>;
export type ServerToolCallConfirmationDetails = z.infer<typeof serverToolCallConfirmationDetailsSchema>;

export type ServerGeminiContentEvent = z.infer<typeof serverGeminiContentEventSchema>;
export type ServerGeminiThoughtEvent = z.infer<typeof serverGeminiThoughtEventSchema>;
export type ServerGeminiToolCallRequestEvent = z.infer<typeof serverGeminiToolCallRequestEventSchema>;
export type ServerGeminiToolCallResponseEvent = z.infer<typeof serverGeminiToolCallResponseEventSchema>;
export type ServerGeminiToolCallConfirmationEvent = z.infer<typeof serverGeminiToolCallConfirmationEventSchema>;
export type ServerGeminiChatCompressedEvent = z.infer<typeof serverGeminiChatCompressedEventSchema>;
export type ServerGeminiErrorEvent = z.infer<typeof serverGeminiErrorEventSchema>;
export type ServerGeminiFinishedEvent = z.infer<typeof serverGeminiFinishedEventSchema>;
export type ServerGeminiUserCancelledEvent = z.infer<typeof serverGeminiUserCancelledEventSchema>;
export type ServerGeminiCitationEvent = z.infer<typeof serverGeminiCitationEventSchema>;
export type ServerGeminiLoopDetectedEvent = z.infer<typeof serverGeminiLoopDetectedEventSchema>;
export type ServerGeminiMaxSessionTurnsEvent = z.infer<typeof serverGeminiMaxSessionTurnsEventSchema>;
export type ServerGeminiRetryEvent = z.infer<typeof serverGeminiRetryEventSchema>;
export type ServerGeminiContextWindowWillOverflowEvent = z.infer<
  typeof serverGeminiContextWindowWillOverflowEventSchema
>;
export type ServerGeminiInvalidStreamEvent = z.infer<typeof serverGeminiInvalidStreamEventSchema>;
export type ServerGeminiModelInfoEvent = z.infer<typeof serverGeminiModelInfoEventSchema>;
export type ServerGeminiAgentExecutionStoppedEvent = z.infer<typeof serverGeminiAgentExecutionStoppedEventSchema>;
export type ServerGeminiAgentExecutionBlockedEvent = z.infer<typeof serverGeminiAgentExecutionBlockedEventSchema>;

/**
 * Union type for all SDK stream events.
 * Matches SDK's ServerGeminiStreamEvent type.
 */
export type ServerGeminiStreamEvent = z.infer<typeof serverGeminiStreamEventSchema>;
