/**
 * Cursor SDK Adapter Namespace
 *
 * Defines internal bus subjects for the cursor-sdk adapter.
 * These subjects are emitted by the connector layer and consumed by the
 * agent layer, which wires them to global AgentSubjects.
 *
 * Event groupings:
 * - sdk.event: Catch-all for raw Cursor SDK events (observability/debugging)
 * - Semantic subjects: Typed events mapped from Cursor's InteractionUpdate union
 * - Turn lifecycle: Turn state machine transitions (turn.state_changed, turn.*)
 * - Cursor-specific: Shell output, summary, status, run lifecycle events
 * - tool_approval: RPC bridge for tool execution consent
 *
 * Cursor SDK event types from agent.send() onDelta:
 *   text-delta, thinking-delta, thinking-completed, tool-call-started,
 *   tool-call-completed, shell-output-delta, summary-started, summary-completed,
 *   turn-ended, status-changed, run.created
 *
 * Note on enrichment:
 * - Semantic subjects are emitted by CursorConnectorSession with connector identity
 *   metadata because the agent layer subscribes through an agentId-filtered bus.
 * - turn.* subjects are emitted by CursorSdkTurn and carry agentId explicitly
 *   through TurnStateChangedSchema.
 */

import { createAdapterNamespace, ScopedToolApprovalSchema } from '@makaio/ai-adapters-core';
import { TurnStateChangedSchema } from '@makaio/ai-adapters-stream-session';
import type { ScopedBusFor } from '@makaio/bus-core';
import { z } from 'zod';
import { CURSOR_SDK_NAMESPACE } from '../types/index.js';

// =============================================================================
// Catch-all raw event schema
// =============================================================================

/**
 * Loose schema for raw Cursor SDK events from agent.send() onDelta.
 *
 * Uses loose object mode to avoid coupling to Cursor SDK's exact internal types
 * while retaining the `type` discriminator for observability routing.
 * Semantic subjects below carry normalized, framework-conventional payloads.
 */
export const SdkEventSchema = z.looseObject({ type: z.string() });

export type SdkEvent = z.infer<typeof SdkEventSchema>;

// =============================================================================
// Semantic event schemas (framework convention: eventType, not type)
// =============================================================================

/**
 * Streaming text delta from the model's current response message.
 * Mapped from Cursor's InteractionUpdate when type === 'text-delta'.
 */
export const TextDeltaSchema = z.looseObject({
  eventType: z.literal('text_delta'),
  /** Incremental text content appended to the current response. */
  delta: z.string(),
});

/**
 * Text generation complete for the current message.
 * Synthesized from accumulated text_delta events.
 */
export const TextCompleteSchema = z.looseObject({
  eventType: z.literal('text_complete'),
  /** Fully accumulated text for the completed response message. */
  text: z.string(),
});

/**
 * Streaming thinking/reasoning delta from the model's internal chain-of-thought.
 * Mapped from Cursor's InteractionUpdate when type === 'thinking-delta'.
 */
export const ThinkingDeltaSchema = z.looseObject({
  eventType: z.literal('thinking_delta'),
  /** Incremental reasoning content appended to the current thinking block. */
  delta: z.string(),
});

/**
 * Thinking/reasoning complete for the current message.
 * Mapped from Cursor's InteractionUpdate when type === 'thinking-completed'.
 */
export const ThinkingCompleteSchema = z.looseObject({
  eventType: z.literal('thinking_complete'),
  /** Fully accumulated reasoning content for the thinking block. */
  text: z.string(),
  /** Duration of the thinking phase in milliseconds, if provided by the SDK. */
  durationMs: z.number().optional(),
});

/**
 * Full message object emitted when a single message finishes.
 * Typed as unknown to avoid coupling to the SDK's exact shape.
 */
export const MessageCompleteSchema = z.looseObject({
  eventType: z.literal('message_complete'),
  /**
   * Cursor SDK's full message content.
   * Typed as unknown — callers may narrow via type guard after inspecting role/content fields.
   */
  content: z.unknown(),
});

/**
 * Token usage summary for a completed message or turn.
 */
export const UsageSchema = z.looseObject({
  eventType: z.literal('usage'),
  /**
   * Cursor SDK's usage object.
   * Typed as unknown to avoid coupling to the SDK's exact shape.
   */
  usage: z.unknown(),
});

/**
 * Tool execution has started.
 * Mapped from Cursor's InteractionUpdate when type === 'tool-call-started'.
 */
export const ToolStartedEventSchema = z.looseObject({
  eventType: z.literal('tool_started'),
  /** Name of the tool that started. */
  toolName: z.string(),
  /** Unique identifier for this tool call. */
  toolCallId: z.string(),
  /** Tool arguments provided to the tool call. */
  args: z.unknown().optional(),
});
export type ToolStartedEvent = z.infer<typeof ToolStartedEventSchema>;

/**
 * Tool execution has completed (success or error).
 * Mapped from Cursor's InteractionUpdate when type === 'tool-call-completed'.
 *
 * NOTE: Cursor SDK surfaces a structured result object and an `isError` flag;
 * serializing to a plain string would be lossy. Fields: toolName, toolCallId,
 * result (unknown), isError.
 */
export const ToolCompletedSchema = z.looseObject({
  eventType: z.literal('tool_completed'),
  /** Name of the tool that was executed. */
  toolName: z.string(),
  /** Unique identifier for this tool call. */
  toolCallId: z.string(),
  /**
   * Tool execution result.
   * Typed as unknown — callers inspect the shape via Cursor SDK's tool result types.
   */
  result: z.unknown(),
  /** Whether the tool returned an error result. */
  isError: z.boolean(),
});

/**
 * Agent has started processing a prompt.
 * Mapped from Cursor's run.created event.
 */
export const AgentStartedEventSchema = z.looseObject({
  eventType: z.literal('agent_started'),
  /** Model being used for this session. */
  model: z.string().optional(),
  /** Run identifier assigned by Cursor SDK. */
  runId: z.string(),
});
export type AgentStartedEvent = z.infer<typeof AgentStartedEventSchema>;

/**
 * Agent has finished a full prompt run.
 * Mapped from Cursor's turn-ended event.
 */
export const AgentCompleteSchema = z.looseObject({
  eventType: z.literal('agent_complete'),
  /**
   * Final result payload from the completed agent run.
   * Typed as unknown — callers narrow via Cursor SDK's result types.
   */
  result: z.unknown().optional(),
  /** Duration of the agent run in milliseconds. */
  durationMs: z.number().optional(),
});

/**
 * An error occurred during processing.
 *
 * NOTE: Cursor SDK may surface structured error objects rather than plain strings.
 * `error` is typed as unknown to avoid data loss.
 */
export const ErrorSchema = z.looseObject({
  eventType: z.literal('error'),
  /**
   * Cursor SDK's error object.
   * Typed as unknown — callers narrow via Cursor SDK's error types or standard Error.
   */
  error: z.unknown(),
  /** Optional human-readable error message extracted from the error object. */
  message: z.string().optional(),
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
// Cursor-specific lifecycle events
// =============================================================================

/**
 * Streaming shell command output delta.
 * Mapped from Cursor's InteractionUpdate when type === 'shell-output-delta'.
 */
export const ShellOutputDeltaSchema = z.looseObject({
  eventType: z.literal('shell_output_delta'),
  /** Incremental shell output content. */
  delta: z.string(),
});

/**
 * Agent has started generating a summary of its actions.
 * Mapped from Cursor's summary-started event.
 */
export const SummaryStartedSchema = z.looseObject({
  eventType: z.literal('summary_started'),
});

/**
 * Agent has completed its summary.
 * Mapped from Cursor's summary-completed event.
 */
export const SummaryCompleteSchema = z.looseObject({
  eventType: z.literal('summary_complete'),
  /** Full summary text generated by the agent. */
  text: z.string(),
});

/**
 * Agent operational status has changed.
 * Mapped from Cursor's status-changed event.
 */
export const StatusChangedSchema = z.looseObject({
  eventType: z.literal('status_changed'),
  /** New operational status string. */
  status: z.string(),
  /** Optional human-readable status message. */
  message: z.string().optional(),
});

/**
 * A new Cursor run has been created for this turn.
 * Mapped from Cursor's run.created event.
 */
export const RunCreatedSchema = z.looseObject({
  eventType: z.literal('run.created'),
  /** Run identifier assigned by Cursor SDK. */
  runId: z.string(),
});

// =============================================================================
// Namespace schemas record
// =============================================================================

/**
 * Cursor SDK Adapter schemas record.
 *
 * Extracted as a named const so that FilterPayload type computation via
 * `typeof cursorSdkSchemas` is available to consumers.
 */
const cursorSdkSchemas = {
  // Catch-all raw event (observability / debugging, pre-normalization)
  'sdk.event': SdkEventSchema,

  // Semantic events — normalized from Cursor's InteractionUpdate
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

  // Cursor-specific lifecycle events
  shell_output_delta: ShellOutputDeltaSchema,
  summary_started: SummaryStartedSchema,
  summary_complete: SummaryCompleteSchema,
  status_changed: StatusChangedSchema,
  'run.created': RunCreatedSchema,

  // Tool approval RPC — connector emits request, agent enriches and forwards
  // to global AgentSubjects.toolApprove. sessionId is optional at connector layer;
  // the agent layer injects it from context.
  tool_approval: ScopedToolApprovalSchema,
} as const;

// =============================================================================
// Namespace registration
// =============================================================================

/**
 * Cursor SDK Adapter Namespace.
 *
 * Scoped bus namespace for all internal events between the Cursor SDK connector
 * and the agent layer. Registered under `'adapter:cursorSdk'`.
 */
export const CursorSdkNamespace = createAdapterNamespace(CURSOR_SDK_NAMESPACE, cursorSdkSchemas);

/**
 * Typed subject literals for the Cursor SDK adapter.
 *
 * Use these constants to subscribe to specific subjects with full type safety.
 * @example
 * ```typescript
 * connector.on(CursorSdkSubjects.text_delta, (ctx) => {
 *   // ctx.payload is typed as TextDelta
 *   process.stdout.write(ctx.payload.delta);
 * });
 * ```
 */
export const CursorSdkSubjects = CursorSdkNamespace.subjects;

/**
 * Scoped bus type for the Cursor SDK adapter.
 * Includes FilterPayload for type-safe withFilter() calls.
 */
export type CursorSdkBus = ScopedBusFor<typeof CursorSdkNamespace>;

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
export type ShellOutputDelta = z.infer<typeof ShellOutputDeltaSchema>;
export type SummaryStarted = z.infer<typeof SummaryStartedSchema>;
export type SummaryComplete = z.infer<typeof SummaryCompleteSchema>;
export type StatusChanged = z.infer<typeof StatusChangedSchema>;
export type RunCreated = z.infer<typeof RunCreatedSchema>;
