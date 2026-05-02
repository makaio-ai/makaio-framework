import { createAdapterNamespace, ScopedToolApprovalSchema } from '@makaio/ai-adapters-core';
import type { ScopedBus } from '@makaio/bus-core';
import { z } from 'zod';
import { ANTHROPIC_SDK_NAMESPACE } from '../types/index.js';

// Import all typed schemas
import {
  ChunkEventSchema,
  UsageEventSchema,
  ToolCallsEventSchema,
  MessageCompleteEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningCompleteEventSchema,
  AgentStartedEventSchema,
  AgentCompleteEventSchema,
  ErrorEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  TurnStateChangedSchema,
} from './schemas/index.js';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages.js';

// Re-export all schemas for external use
export {
  AgentCompleteEventSchema,
  AgentStartedEventSchema,
  ChunkEventSchema,
  ErrorEventSchema,
  MessageCompleteEventSchema,
  ReasoningCompleteEventSchema,
  ReasoningDeltaEventSchema,
  ToolCallsEventSchema,
  ToolCompletedEventSchema,
  ToolStartedEventSchema,
  TurnStateChangedSchema,
  UsageEventSchema,
} from './schemas/index.js';
export type {
  AgentCompleteEvent,
  AgentStartedEvent,
  ChunkEvent,
  ErrorEvent,
  MessageCompleteEvent,
  ReasoningCompleteEvent,
  ReasoningDeltaEvent,
  ToolCall,
  ToolCallsEvent,
  ToolCompletedEvent,
  ToolStartedEvent,
  TurnStateChanged,
  UsageEvent,
} from './schemas/index.js';

/**
 * Discriminated union of all SDK event types.
 * Uses discriminatedUnion for type-safe event routing based on eventType.
 * Turn lifecycle events use dedicated `turn.*` subjects below because the shared
 * stream-session state schema is keyed by state transition fields, not `eventType`.
 */
export const SdkEventMessageSchema = z.discriminatedUnion('eventType', [
  ChunkEventSchema,
  UsageEventSchema,
  ToolCallsEventSchema,
  MessageCompleteEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningCompleteEventSchema,
  AgentStartedEventSchema,
  AgentCompleteEventSchema,
  ErrorEventSchema,
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
]);

export type SdkEventMessage = z.infer<typeof SdkEventMessageSchema>;

/**
 * Envelope schema for sdk.event catch-all subject.
 * Wraps the discriminated union in an envelope for proper TypeScript narrowing at emit time.
 * Pattern matches codex-mcp's \{ id, msg \} envelope.
 */
export const SdkEventSchema = z.object({
  event: SdkEventMessageSchema,
  adapterName: z.string().optional(),
  agentId: z.string().optional(),
  adapterId: z.string().optional(),
  adapterSessionId: z.string().optional(),
  sessionId: z.string().optional(),
});

export type SdkEvent = z.infer<typeof SdkEventSchema>;

/**
 * Schema for raw Anthropic streaming events.
 * Passthrough schema for observability - captures raw API response.
 * Used by stream-bridge to emit unprocessed events before normalization.
 */
export const RawChunkSchema = z.custom<RawMessageStreamEvent>(() => true);

export type RawChunk = z.infer<typeof RawChunkSchema>;

/**
 * Anthropic SDK Adapter Namespace with semantic subjects.
 *
 * Provides typed subjects for:
 * - sdk.event: Catch-all for raw SDK events (for observability/debugging)
 * - tool_approval: RPC for tool execution approval
 * - Semantic subjects: Individual typed events for agent layer processing
 */
export const AnthropicSdkConnectorNamespace = createAdapterNamespace(ANTHROPIC_SDK_NAMESPACE, {
  // Raw events from Anthropic API (observability, pre-normalization)
  'sdk.raw': RawChunkSchema,

  // Normalized semantic events (post-normalization)
  'sdk.event': SdkEventSchema,

  // Tool approval RPC - routes to global AgentSubjects.toolApprove via agent.ts wiring
  // Uses scoped schema with optional sessionId; agent layer injects it from context.
  tool_approval: ScopedToolApprovalSchema,

  // Semantic subjects for typed event handling
  // Streaming events
  chunk: ChunkEventSchema,
  usage: UsageEventSchema,

  // Message events
  message_complete: MessageCompleteEventSchema,
  reasoning_delta: ReasoningDeltaEventSchema,
  reasoning_complete: ReasoningCompleteEventSchema,

  // Tool events
  tool_calls: ToolCallsEventSchema,
  tool_started: ToolStartedEventSchema,
  tool_completed: ToolCompletedEventSchema,

  // Lifecycle events
  agent_started: AgentStartedEventSchema,
  agent_complete: AgentCompleteEventSchema,
  error: ErrorEventSchema,

  // Turn lifecycle events
  'turn.state_changed': TurnStateChangedSchema,
  'turn.turn_started': TurnStateChangedSchema,
  'turn.step_started': TurnStateChangedSchema,
  'turn.step_finished': TurnStateChangedSchema,
  'turn.turn_finished': TurnStateChangedSchema,
});

/**
 * Typed subject literals for Anthropic SDK adapter.
 * Use these constants to subscribe to specific message types with full type safety.
 * @example
 * ```typescript
 * connector.on(AnthropicSdkSubjects.chunk, (ctx) => {
 *   // ctx.payload is typed as ChunkEvent
 *   console.debug(ctx.payload.delta);
 * });
 * ```
 */
export const AnthropicSdkConnectorSubjects = AnthropicSdkConnectorNamespace.subjects;

/**
 * Scoped bus type for Anthropic SDK adapter namespace subjects.
 * Re-exported here for convenience alongside connector subjects.
 */
export type AnthropicSdkConnectorBus = ScopedBus<typeof ANTHROPIC_SDK_NAMESPACE>;
