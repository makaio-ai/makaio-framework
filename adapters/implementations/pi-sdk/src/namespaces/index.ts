/**
 * Pi SDK Adapter Namespace
 *
 * Defines internal bus subjects for the pi-sdk adapter.
 * These subjects are emitted by the connector layer and consumed by the
 * agent layer, which wires them to global AgentSubjects.
 *
 * Event groupings:
 * - sdk.event: Catch-all for raw Pi SDK events (observability/debugging)
 * - Semantic subjects: Typed events mapped from Pi's AgentSessionEvent union
 * - Turn lifecycle: Turn state machine transitions (turn.state_changed, turn.*)
 * - Pi-specific: Compaction, auto-retry, and queue events unique to Pi SDK
 * - tool_approval: RPC bridge for tool execution consent
 *
 * Pi SDK event types from session.subscribe():
 *   agent_start, turn_start, message_start, message_end, message_update,
 *   tool_execution_start, tool_execution_end, turn_end, agent_end,
 *   compaction_start, compaction_end, auto_retry_start, auto_retry_end,
 *   queue_update
 *
 * message_update sub-types: text_delta, text_end, thinking_delta, thinking_end
 *
 * Note on enrichment:
 * - Semantic subjects are emitted by PiConnectorSession with connector identity
 *   metadata because the agent layer subscribes through an agentId-filtered bus.
 * - turn.* subjects are emitted by PiConnectorTurn and carry agentId explicitly
 *   through TurnStateChangedSchema.
 */

import { createAdapterNamespace, ScopedToolApprovalSchema } from '@makaio/ai-adapters-core';
import { TurnStateChangedSchema } from '@makaio/ai-adapters-stream-session';
import type { ScopedBusFor } from '@makaio/bus-core';
import { z } from 'zod';

const namespace = 'adapter:piSdk' as const;

// =============================================================================
// Catch-all raw event schema
// =============================================================================

/**
 * Loose schema for raw Pi SDK events from session.subscribe().
 *
 * Uses loose object mode to avoid coupling to Pi SDK's exact internal types while
 * retaining the `type` discriminator for observability routing.
 * Semantic subjects below carry normalized, framework-conventional payloads.
 */
export const SdkEventSchema = z.looseObject({ type: z.string() });

export type SdkEvent = z.infer<typeof SdkEventSchema>;

// =============================================================================
// Semantic event schemas (framework convention: eventType, not type)
// =============================================================================

/**
 * Streaming text delta from the model's current response message.
 * Mapped from Pi's message_update when assistantMessageEvent.type === 'text_delta'.
 */
export const TextDeltaSchema = z.looseObject({
  eventType: z.literal('text_delta'),
  /** Incremental text content appended to the current response */
  delta: z.string(),
});

/**
 * Text generation complete for the current message.
 * Mapped from Pi's message_update when assistantMessageEvent.type === 'text_end'.
 */
export const TextCompleteSchema = z.looseObject({
  eventType: z.literal('text_complete'),
  /** Fully accumulated text for the completed response message */
  text: z.string(),
});

/**
 * Streaming thinking/reasoning delta from the model's internal chain-of-thought.
 * Mapped from Pi's message_update when assistantMessageEvent.type === 'thinking_delta'.
 */
export const ThinkingDeltaSchema = z.looseObject({
  eventType: z.literal('thinking_delta'),
  /** Incremental reasoning content appended to the current thinking block */
  delta: z.string(),
});

/**
 * Thinking/reasoning complete for the current message.
 * Mapped from Pi's message_update when assistantMessageEvent.type === 'thinking_end'.
 */
export const ThinkingCompleteSchema = z.looseObject({
  eventType: z.literal('thinking_complete'),
  /** Fully accumulated reasoning content for the thinking block */
  text: z.string(),
});

/**
 * Full message object emitted when a single message finishes.
 * Mapped from Pi's message_end event.
 *
 * Pi's message shape: `{ role, content, usage, stopReason, errorMessage }`
 */
export const MessageCompleteSchema = z.looseObject({
  eventType: z.literal('message_complete'),
  /**
   * Pi SDK's full message object.
   * Typed as unknown to avoid coupling to the peer dep's exact shape.
   * Callers may narrow via type guard after inspecting the role/content fields.
   */
  message: z.unknown(),
});

/**
 * Token usage summary for a completed message or turn.
 * Pi SDK emits usage data within message_end's message payload.
 *
 * Pi's usage shape: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`
 */
export const UsageSchema = z.looseObject({
  eventType: z.literal('usage'),
  /**
   * Pi SDK's usage object.
   * Typed as unknown to avoid coupling to the peer dep's exact shape.
   */
  usage: z.unknown(),
});

/**
 * Tool execution has started.
 * Mapped from Pi's tool_execution_start event.
 */
export const ToolStartedEventSchema = z.looseObject({
  eventType: z.literal('tool_started'),
  /** Name of the tool that started */
  toolName: z.string(),
  /** Unique identifier for this tool call */
  toolCallId: z.string(),
  /** Tool arguments after Pi SDK validation */
  args: z.record(z.string(), z.unknown()).optional(),
});
export type ToolStartedEvent = z.infer<typeof ToolStartedEventSchema>;

/**
 * Tool execution has completed (success or error).
 * Mapped from Pi's tool_execution_end event.
 *
 * NOTE: This intentionally deviates from the shared ToolCompletedEventSchema
 * (result: z.string(), success: boolean). Pi SDK surfaces a structured result
 * object and an `isError` flag; serializing to a plain string would be lossy.
 * Fields: `toolName`, `toolCallId`, `result` (unknown), `isError`.
 */
export const ToolCompletedSchema = z.looseObject({
  eventType: z.literal('tool_completed'),
  /** Name of the tool that was executed */
  toolName: z.string(),
  /** Unique identifier for this tool call */
  toolCallId: z.string(),
  /**
   * Tool execution result.
   * Typed as unknown — callers inspect the shape via Pi SDK's tool result types.
   */
  result: z.unknown(),
  /** Whether the tool returned an error result */
  isError: z.boolean(),
});

/**
 * Agent has started processing a prompt.
 * Mapped from Pi's agent_start event.
 *
 */
export const AgentStartedEventSchema = z.looseObject({
  eventType: z.literal('agent_started'),
  /** Model being used for this session */
  model: z.string().optional(),
});
export type AgentStartedEvent = z.infer<typeof AgentStartedEventSchema>;

/**
 * Agent has finished a full prompt run.
 * Mapped from Pi's agent_end event.
 *
 * NOTE: Pi's agent_end carries the full conversation messages array via
 * event.messages, which differs from the shared AgentCompleteEventSchema
 * (message: string | undefined). A Pi-specific schema preserves the full payload.
 * Field: `messages` (unknown[]).
 */
export const AgentCompleteSchema = z.looseObject({
  eventType: z.literal('agent_complete'),
  /**
   * Full conversation messages array from the completed agent run.
   * Typed as unknown[] — callers narrow via Pi SDK's message types.
   */
  messages: z.array(z.unknown()),
  /**
   * Accumulated assistant text from the turn, extracted at the session layer.
   * Eliminates the need for the agent layer to parse raw messages.
   */
  text: z.string().optional(),
});

/**
 * An error occurred during processing.
 *
 * NOTE: Pi SDK surfaces structured error objects rather than plain error strings.
 * `error` is typed as unknown rather than using the shared ErrorEventSchema's
 * `message: string` field to avoid data loss. Field: `error` (unknown).
 */
export const ErrorSchema = z.looseObject({
  eventType: z.literal('error'),
  /**
   * Pi SDK's error object.
   * Typed as unknown — callers narrow via Pi SDK's error types or standard Error.
   */
  error: z.unknown(),
});

// =============================================================================
// Turn lifecycle (shared stream-session contract)
// =============================================================================

/**
 * Turn state transition payload.
 * Shared contract from `\@makaio/ai-adapters-stream-session`.
 * Fields: `adapterId`, `agentId`, `oldState`, `newState`, `timestamp`.
 */
export { TurnStateChangedSchema };
export type { TurnStateChanged } from '@makaio/ai-adapters-stream-session';

// =============================================================================
// Pi-specific lifecycle events
// =============================================================================

/**
 * Context compaction has started.
 * Pi SDK compacts the conversation history when the context window fills.
 * Mapped from Pi's compaction_start event.
 */
export const CompactionStartedSchema = z.looseObject({
  eventType: z.literal('compaction_started'),
});

/**
 * Context compaction has finished.
 * Mapped from Pi's compaction_end event.
 */
export const CompactionEndedSchema = z.looseObject({
  eventType: z.literal('compaction_ended'),
});

/**
 * Automatic retry of a failed API call has started.
 * Pi SDK retries transiently failed requests automatically.
 * Mapped from Pi's auto_retry_start event.
 */
export const AutoRetryStartedSchema = z.looseObject({
  eventType: z.literal('auto_retry_started'),
});

/**
 * Automatic retry has ended (either succeeded or exhausted retries).
 * Mapped from Pi's auto_retry_end event.
 */
export const AutoRetryEndedSchema = z.looseObject({
  eventType: z.literal('auto_retry_ended'),
});

/**
 * Queue position or status update from the Pi SDK.
 * Mapped from Pi's queue_update event.
 */
export const QueueUpdateSchema = z.looseObject({
  eventType: z.literal('queue_update'),
});

// =============================================================================
// Namespace schemas record
// =============================================================================

/**
 * Pi SDK Adapter schemas record.
 *
 * Extracted as a named const so that FilterPayload type computation via
 * `typeof piSdkSchemas` is available to consumers.
 */
const piSdkSchemas = {
  // Catch-all raw event (observability / debugging, pre-normalization)
  'sdk.event': SdkEventSchema,

  // Semantic events — normalized from Pi's AgentSessionEvent
  text_delta: TextDeltaSchema,
  text_complete: TextCompleteSchema,
  thinking_delta: ThinkingDeltaSchema,
  thinking_complete: ThinkingCompleteSchema,
  message_complete: MessageCompleteSchema,
  usage: UsageSchema,
  tool_started: ToolStartedEventSchema,
  tool_completed: ToolCompletedSchema,
  agent_started: AgentStartedEventSchema,
  agent_complete: AgentCompleteSchema,
  error: ErrorSchema,

  // Turn lifecycle (shared TurnStateChangedSchema pattern)
  'turn.state_changed': TurnStateChangedSchema,
  'turn.turn_started': TurnStateChangedSchema,
  'turn.step_started': TurnStateChangedSchema,
  'turn.step_finished': TurnStateChangedSchema,
  'turn.turn_finished': TurnStateChangedSchema,

  // Pi-specific lifecycle events
  compaction_started: CompactionStartedSchema,
  compaction_ended: CompactionEndedSchema,
  auto_retry_started: AutoRetryStartedSchema,
  auto_retry_ended: AutoRetryEndedSchema,
  queue_update: QueueUpdateSchema,

  // Tool approval RPC — connector emits request, agent enriches and forwards
  // to global AgentSubjects.toolApprove. sessionId is optional at connector layer;
  // the agent layer injects it from context.
  tool_approval: ScopedToolApprovalSchema,
} as const;

// =============================================================================
// Namespace registration
// =============================================================================

/**
 * Pi SDK Adapter Namespace.
 *
 * Scoped bus namespace for all internal events between the Pi SDK connector
 * and the agent layer. Registered under `'adapter:piSdk'`.
 */
export const PiSdkNamespace = createAdapterNamespace(namespace, piSdkSchemas);

/**
 * Typed subject literals for the Pi SDK adapter.
 *
 * Use these constants to subscribe to specific subjects with full type safety.
 * @example
 * ```typescript
 * connector.on(PiSdkSubjects.text_delta, (ctx) => {
 *   // ctx.payload is typed as TextDelta
 *   process.stdout.write(ctx.payload.delta);
 * });
 * ```
 */
export const PiSdkSubjects = PiSdkNamespace.subjects;

/**
 * Scoped bus type for the Pi SDK adapter.
 * Includes FilterPayload for type-safe withFilter() calls.
 */
export type PiSdkBus = ScopedBusFor<typeof PiSdkNamespace>;

// =============================================================================
// Inferred payload types
// =============================================================================

export type SdkEventPayload = z.infer<typeof SdkEventSchema>;
export type TextDelta = z.infer<typeof TextDeltaSchema>;
export type TextComplete = z.infer<typeof TextCompleteSchema>;
export type ThinkingDelta = z.infer<typeof ThinkingDeltaSchema>;
export type ThinkingComplete = z.infer<typeof ThinkingCompleteSchema>;
export type MessageComplete = z.infer<typeof MessageCompleteSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type ToolCompleted = z.infer<typeof ToolCompletedSchema>;
export type AgentComplete = z.infer<typeof AgentCompleteSchema>;
export type ErrorEvent = z.infer<typeof ErrorSchema>;
export type CompactionStarted = z.infer<typeof CompactionStartedSchema>;
export type CompactionEnded = z.infer<typeof CompactionEndedSchema>;
export type AutoRetryStarted = z.infer<typeof AutoRetryStartedSchema>;
export type AutoRetryEnded = z.infer<typeof AutoRetryEndedSchema>;
export type QueueUpdate = z.infer<typeof QueueUpdateSchema>;
