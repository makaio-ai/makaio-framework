import { createAdapterNamespace } from '@makaio/ai-adapters-core';
import type { ScopedBus } from '@makaio/bus-core';
import { z } from 'zod';
import type { ServerGeminiStreamEvent as SdkServerGeminiStreamEvent } from '@google/gemini-cli-core';

// Import raw event schemas
import {
  InitializedEventSchema,
  SessionCreatedEventSchema,
  SessionCompletedEventSchema,
  SessionFinishedEventSchema,
  SessionErrorEventSchema,
} from './schemas/session-lifecycle.js';
import { AgentThoughtChunkEventSchema } from './schemas/agent-thought.js';
import { AgentMessageChunkEventSchema } from './schemas/agent-message.js';
import { UserMessageChunkEventSchema } from './schemas/user-message.js';
import { ToolCallEventSchema, ToolCallUpdateEventSchema } from './schemas/tool-execution.js';
import { PlanEventSchema } from './schemas/plan.js';
import { PermissionRequestEventSchema } from './schemas/permission.js';
import { usageMetadataSchema, finishReasonSchema } from './schemas/sdk-event.js';
import { GeminiToolApprovalSchema } from './schemas/tool-approval.js';
import { TurnStateChangedSchema } from './schemas/turn-state.js';
import type { ContentBlock } from './schemas/_acp-types.js';

// Re-export all schemas and types
export {
  chatCompressionInfoSchema,
  CompressionStatus,
  finishReasonSchema,
  geminiErrorEventValueSchema,
  GeminiEventType,
  geminiFinishedEventValueSchema,
  serverGeminiAgentExecutionBlockedEventSchema,
  serverGeminiAgentExecutionStoppedEventSchema,
  serverGeminiChatCompressedEventSchema,
  serverGeminiCitationEventSchema,
  serverGeminiContentEventSchema,
  serverGeminiContextWindowWillOverflowEventSchema,
  serverGeminiErrorEventSchema,
  serverGeminiFinishedEventSchema,
  serverGeminiInvalidStreamEventSchema,
  serverGeminiLoopDetectedEventSchema,
  serverGeminiMaxSessionTurnsEventSchema,
  serverGeminiModelInfoEventSchema,
  serverGeminiRetryEventSchema,
  serverGeminiStreamEventSchema,
  serverGeminiThoughtEventSchema,
  serverGeminiToolCallConfirmationEventSchema,
  serverGeminiToolCallRequestEventSchema,
  serverGeminiToolCallResponseEventSchema,
  serverGeminiUserCancelledEventSchema,
  serverToolCallConfirmationDetailsSchema,
  structuredErrorSchema,
  thoughtSummarySchema,
  toolCallRequestInfoSchema,
  toolCallResponseInfoSchema,
  usageMetadataSchema,
} from './schemas/sdk-event.js';
export type {
  ChatCompressionInfo,
  GeminiErrorEventValue,
  GeminiFinishedEventValue,
  ServerGeminiAgentExecutionBlockedEvent,
  ServerGeminiAgentExecutionStoppedEvent,
  ServerGeminiChatCompressedEvent,
  ServerGeminiCitationEvent,
  ServerGeminiContentEvent,
  ServerGeminiContextWindowWillOverflowEvent,
  ServerGeminiErrorEvent,
  ServerGeminiFinishedEvent,
  ServerGeminiInvalidStreamEvent,
  ServerGeminiLoopDetectedEvent,
  ServerGeminiMaxSessionTurnsEvent,
  ServerGeminiModelInfoEvent,
  ServerGeminiRetryEvent,
  ServerGeminiStreamEvent,
  ServerGeminiThoughtEvent,
  ServerGeminiToolCallConfirmationEvent,
  ServerGeminiToolCallRequestEvent,
  ServerGeminiToolCallResponseEvent,
  ServerGeminiUserCancelledEvent,
  ServerToolCallConfirmationDetails,
  StructuredError,
  ThoughtSummary,
  ToolCallRequestInfo,
  ToolCallResponseInfo,
} from './schemas/sdk-event.js';
export { GeminiToolApprovalSchema } from './schemas/tool-approval.js';
export type { GeminiToolApprovalRequest, GeminiToolApprovalResponse } from './schemas/tool-approval.js';
export {
  InitializedEventSchema,
  SessionCompletedEventSchema,
  SessionCreatedEventSchema,
  SessionErrorEventSchema,
  SessionFinishedEventSchema,
} from './schemas/session-lifecycle.js';
export type {
  InitializedEvent,
  SessionCompletedEvent,
  SessionCreatedEvent,
  SessionErrorEvent,
  SessionFinishedEvent,
} from './schemas/session-lifecycle.js';
export { AgentThoughtChunkEventSchema } from './schemas/agent-thought.js';
export type { AgentThoughtChunkEvent } from './schemas/agent-thought.js';
export { AgentMessageChunkEventSchema } from './schemas/agent-message.js';
export type { AgentMessageChunkEvent } from './schemas/agent-message.js';
export { UserMessageChunkEventSchema } from './schemas/user-message.js';
export type { UserMessageChunkEvent } from './schemas/user-message.js';
export { ToolCallEventSchema, ToolCallUpdateEventSchema } from './schemas/tool-execution.js';
export type { ToolCallEvent, ToolCallUpdateEvent } from './schemas/tool-execution.js';
export { PlanEventSchema } from './schemas/plan.js';
export type { PlanEvent } from './schemas/plan.js';
export { PermissionRequestEventSchema } from './schemas/permission.js';
export type { PermissionRequestEvent } from './schemas/permission.js';
export { GeminiTurnStateSchema, TurnStateChangedSchema } from './schemas/turn-state.js';
export type { GeminiTurnState, TurnStateChanged } from './schemas/turn-state.js';

// Use raw event schemas directly - no enrichment at namespace level
// Enrichment (agentId, adapterId, adapterName) happens at the mapper level
export const InitializedSchema = InitializedEventSchema;
export const SessionCreatedSchema = SessionCreatedEventSchema;
export const SessionCompletedSchema = SessionCompletedEventSchema;
export const SessionFinishedSchema = SessionFinishedEventSchema;
export const SessionErrorSchema = SessionErrorEventSchema;
export const AgentThoughtChunkSchema = AgentThoughtChunkEventSchema;
export const AgentMessageChunkSchema = AgentMessageChunkEventSchema;
export const UserMessageChunkSchema = UserMessageChunkEventSchema;
export const ToolCallSchema = ToolCallEventSchema;
export const ToolCallUpdateSchema = ToolCallUpdateEventSchema;
export const PlanSchema = PlanEventSchema;
export const PermissionRequestSchema = PermissionRequestEventSchema;

// Export pure adapter types (no enrichment)
export type Initialized = z.infer<typeof InitializedSchema>;
export type SessionCreated = z.infer<typeof SessionCreatedSchema>;
export type SessionCompleted = z.infer<typeof SessionCompletedSchema>;
export type SessionFinished = z.infer<typeof SessionFinishedSchema>;
export type SessionError = z.infer<typeof SessionErrorSchema>;
export type AgentThoughtChunk = z.infer<typeof AgentThoughtChunkSchema>;
export type AgentMessageChunk = z.infer<typeof AgentMessageChunkSchema>;
export type UserMessageChunk = z.infer<typeof UserMessageChunkSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolCallUpdate = z.infer<typeof ToolCallUpdateSchema>;
export type Plan = z.infer<typeof PlanSchema>;
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

const namespace = 'adapter:geminiSDK' as const;

// =============================================================================
// Unified SDK Event Schemas for catch-all `sdk.event` subject
// Each schema has a `type` field matching the semantic subject name for routing.
// =============================================================================

/** Session created event - emitted when session is initialized */
const SdkSessionCreatedSchema = z.object({
  type: z.literal('session.created'),
  cwd: z.string(),
  model: z.string(),
});

/** Session completed event - emitted when turn completes with response */
const SdkSessionCompletedSchema = z.object({
  type: z.literal('session.completed'),
  message: z.string(),
});

/** Session finished event - emitted with usage metadata after turn ends */
const SdkSessionFinishedSchema = z.object({
  type: z.literal('session.finished'),
  model: z.string().optional(),
  reason: finishReasonSchema.optional(),
  usageMetadata: usageMetadataSchema.optional(),
});

/** Session error event - emitted on SDK errors */
const SdkSessionErrorSchema = z.object({
  type: z.literal('session.error'),
  error: z.string(),
  status: z.number().optional(),
});

/** Agent message chunk event - streaming content from model */
export type SdkAgentMessageChunk = {
  type: 'agent.message.chunk';
  content: ContentBlock;
};
const SdkAgentMessageChunkSchema = z.custom<SdkAgentMessageChunk>(() => true);

/** Agent thought chunk event - streaming reasoning/thinking content */
export type SdkAgentThoughtChunk = {
  type: 'agent.thought.chunk';
  content: ContentBlock;
};
const SdkAgentThoughtChunkSchema = z.custom<SdkAgentThoughtChunk>(() => true);

/** Tool started event - emitted when tool execution begins */
const SdkToolStartedSchema = z.object({
  type: z.literal('agent.tool.started'),
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string(),
  status: z.string(),
  rawInput: z.unknown().optional(),
});

/** Tool updated event - emitted when tool execution completes or status changes */
const SdkToolUpdatedSchema = z.object({
  type: z.literal('agent.tool.updated'),
  toolCallId: z.string(),
  status: z.string().optional().nullable(),
  /** Tool execution output - available on successful completion */
  output: z.unknown().optional(),
});

/** Raw SDK event wrapper - for observability/debugging of raw Turn.run() events */
type SdkRawEvent = {
  type: 'sdk.raw';
  raw: SdkServerGeminiStreamEvent;
};

/**
 * Union of ALL event types for catch-all `sdk.event` subject.
 * Events are discriminated by `type` field matching semantic subject names.
 *
 * Note: Using z.custom instead of z.discriminatedUnion because some schemas
 * use z.custom<T>() (for Zod v3/v4 compatibility) which isn't discriminable.
 */
export type SdkEvent =
  | z.infer<typeof SdkSessionCreatedSchema>
  | z.infer<typeof SdkSessionCompletedSchema>
  | z.infer<typeof SdkSessionFinishedSchema>
  | z.infer<typeof SdkSessionErrorSchema>
  | SdkAgentMessageChunk
  | SdkAgentThoughtChunk
  | z.infer<typeof SdkToolStartedSchema>
  | z.infer<typeof SdkToolUpdatedSchema>
  | SdkRawEvent;

export const AllSdkEventsSchema = z.custom<SdkEvent>(() => true);

/**
 * Gemini SDK Adapter Namespace
 *
 * Single namespace approach with all event types and internal routing.
 * The 'sdk.event' subject receives ALL events (SDK stream events + custom lifecycle events)
 * as a discriminated union. The agent layer transforms these to semantic subjects.
 *
 * IMPORTANT: Semantic subjects MUST use the same Sdk* schemas as AllSdkEventsSchema
 * to enable type-safe passthrough via createSemanticEventMapping.
 */
export const GeminiConnectorNamespace = createAdapterNamespace(namespace, {
  // Catch-all subject - receives ALL events (SDK + lifecycle) as discriminated union
  'sdk.event': AllSdkEventsSchema,

  // Tool approval (SDK-level) - mirrors ToolCallRequestInfo from Gemini SDK
  'acp.tool_approval': GeminiToolApprovalSchema,

  // Semantic subjects - use same schemas as AllSdkEventsSchema for type-safe passthrough
  'session.created': SdkSessionCreatedSchema,
  'session.completed': SdkSessionCompletedSchema,
  'session.finished': SdkSessionFinishedSchema,
  'session.error': SdkSessionErrorSchema,
  'agent.message.chunk': SdkAgentMessageChunkSchema,
  'agent.thought.chunk': SdkAgentThoughtChunkSchema,
  'agent.tool.started': SdkToolStartedSchema,
  'agent.tool.updated': SdkToolUpdatedSchema,

  // Turn lifecycle events
  'turn.state_changed': TurnStateChangedSchema,
  'turn.turn_started': TurnStateChangedSchema,
  'turn.step_started': TurnStateChangedSchema,
  'turn.step_finished': TurnStateChangedSchema,
  'turn.turn_finished': TurnStateChangedSchema,
});

/**
 * Typed subject literals for Gemini ACP adapter.
 * Use these constants to subscribe to specific message types with full type safety.
 */
export const GeminiConnectorSubjects = GeminiConnectorNamespace.subjects;

/** Scoped bus type for Gemini ACP adapter */
export type GeminiConnectorBus = ScopedBus<typeof namespace>;
