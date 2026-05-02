/**
 * Qwen ACP Adapter Namespace
 *
 * Defines internal bus events for the qwen-acp adapter.
 * These events are emitted by the adapter and consumed by the core system.
 *
 * Event groupings:
 * - Turn lifecycle: bracket each agent turn (emitted directly by QwenAcpTurn via bus)
 * - Session updates: streaming content from ACP session/update notifications
 *   (emitted via AIAgentConnector.emit(), which auto-injects agentId/adapterSessionId)
 * - Tool approval: scoped RPC for requesting user permission before tool execution
 *
 * Note on enrichment:
 * - Turn lifecycle events include `agentId` directly (emitted by QwenAcpTurn via bus.emit())
 * - Session update events must NOT include `agentId` or `adapterSessionId` in their schemas'
 *   "required to be passed" fields: `AIAgentConnector.emit()` auto-injects these (Forbid type)
 */

import { z } from 'zod';
import { createAdapterNamespace, ScopedToolApprovalSchema, type ScopedBusFor } from '@makaio/ai-adapters-core';

const namespace = 'adapter:qwen-acp' as const;

// -- Turn lifecycle schemas --
// These are emitted directly by QwenAcpTurn via bus.emit(), so agentId is included explicitly.

/**
 * Emitted when a new agent turn begins.
 */
const TurnStartedSchema = z.object({
  agentId: z.string(),
  timestamp: z.number(),
});

/**
 * Emitted when an agent turn ends (normally or via error).
 */
const TurnFinishedSchema = z.object({
  agentId: z.string(),
  timestamp: z.number(),
  stopReason: z.string().optional(),
});

/**
 * Emitted when a discrete step within a turn starts (e.g., tool call, generation).
 */
const TurnStepStartedSchema = z.object({
  agentId: z.string(),
  stepType: z.string(),
  timestamp: z.number(),
});

/**
 * Emitted when a discrete step within a turn finishes.
 */
const TurnStepFinishedSchema = z.object({
  agentId: z.string(),
  stepType: z.string(),
  timestamp: z.number(),
});

/**
 * Emitted on each state transition within a turn's state machine.
 */
const TurnStateChangedSchema = z.object({
  agentId: z.string(),
  previousState: z.string(),
  newState: z.string(),
  timestamp: z.number(),
});

// -- Session update schemas (from ACP session/update notifications) --
// Emitted via AIAgentConnector.emit(), which auto-injects:
//   agentId, adapterId, adapterName, adapterSessionId
// These fields must NOT be in the "passed" payload (they are Forbid-ed by the connector).
// Consumers can read agentId/adapterSessionId from the enriched event context.

/**
 * Streaming text delta from the model's response message.
 */
const MessageChunkSchema = z.object({
  delta: z.string(),
  timestamp: z.number(),
});

/**
 * Streaming text delta from the model's internal reasoning/thinking.
 */
const ThoughtChunkSchema = z.object({
  delta: z.string(),
  timestamp: z.number(),
});

/**
 * Emitted when the model initiates a tool call.
 */
const ToolCallSchema = z.object({
  toolCallId: z.string(),
  title: z.string(),
  kind: z.string().optional(),
  rawInput: z.unknown().optional(),
  timestamp: z.number(),
});

/**
 * Emitted when a tool call completes or its status changes.
 */
const ToolCallUpdateSchema = z.object({
  toolCallId: z.string(),
  status: z.string().optional(),
  rawOutput: z.unknown().optional(),
  timestamp: z.number(),
});

/**
 * Emitted with token usage information from `agent_message_chunk._meta.usage`.
 *
 * Fields mirror the Qwen Code ACP agent's per-turn usage payload:
 * `inputTokens`, `outputTokens`, `totalTokens`, `thoughtTokens`, `cachedReadTokens`.
 */
const UsageUpdateSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  thoughtTokens: z.number().optional(),
  cachedReadTokens: z.number().optional(),
  timestamp: z.number(),
});

/**
 * Emitted when the ACP `usage_update` notification is received, carrying
 * the full context-window capacity and current occupancy.
 *
 * `size` is the model's context window limit in tokens.
 * `used` is the number of tokens currently occupying the context.
 */
const ContextWindowUpdateSchema = z.object({
  size: z.number(),
  used: z.number(),
  timestamp: z.number(),
});

/**
 * Emitted by the connector after a prompt turn completes successfully.
 *
 * Carries the full accumulated text so the agent can forward it to
 * `AgentSubjects.message` for session persistence.
 * Emitted directly by the connector via `bus.emit()`, so `agentId` must
 * be included explicitly (same pattern as turn lifecycle events).
 */
const TurnTextCompletedSchema = z.object({
  agentId: z.string(),
  text: z.string(),
  timestamp: z.number(),
});

/**
 * Qwen ACP Adapter schemas.
 * Extracted as const to enable FilterPayload type computation via typeof.
 */
const qwenAcpSchemas = {
  // Turn lifecycle
  turn_started: TurnStartedSchema,
  turn_finished: TurnFinishedSchema,
  turn_step_started: TurnStepStartedSchema,
  turn_step_finished: TurnStepFinishedSchema,
  turn_state_changed: TurnStateChangedSchema,

  // Session updates
  session_update_message_chunk: MessageChunkSchema,
  session_update_thought_chunk: ThoughtChunkSchema,
  session_update_tool_call: ToolCallSchema,
  session_update_tool_call_update: ToolCallUpdateSchema,
  session_update_usage: UsageUpdateSchema,
  session_update_context_window: ContextWindowUpdateSchema,

  // Turn completion — emitted by connector via bus.emit() (includes agentId explicitly)
  turn_text_completed: TurnTextCompletedSchema,

  // Tool approval RPC — connector emits request, agent enriches and forwards to global bus
  permission_request: ScopedToolApprovalSchema,
} as const;

/**
 * Qwen ACP Adapter Namespace
 *
 * Defines the event subjects and schemas for internal bus communication
 * between the qwen-acp adapter and the core system.
 */
export const QwenAcpNamespace = createAdapterNamespace(namespace, qwenAcpSchemas);

/**
 * Typed subject literals for Qwen ACP adapter.
 * Use these constants to subscribe to specific message types with full type safety.
 */
export const QwenAcpSubjects = QwenAcpNamespace.subjects;

/** Scoped bus type for Qwen ACP adapter - includes FilterPayload for type-safe filtering. */
export type QwenAcpBus = ScopedBusFor<typeof QwenAcpNamespace>;

// Inferred payload types
export type TurnStarted = z.infer<typeof TurnStartedSchema>;
export type TurnFinished = z.infer<typeof TurnFinishedSchema>;
export type TurnStepStarted = z.infer<typeof TurnStepStartedSchema>;
export type TurnStepFinished = z.infer<typeof TurnStepFinishedSchema>;
export type TurnStateChanged = z.infer<typeof TurnStateChangedSchema>;
export type MessageChunk = z.infer<typeof MessageChunkSchema>;
export type ThoughtChunk = z.infer<typeof ThoughtChunkSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolCallUpdate = z.infer<typeof ToolCallUpdateSchema>;
export type UsageUpdate = z.infer<typeof UsageUpdateSchema>;
export type ContextWindowUpdate = z.infer<typeof ContextWindowUpdateSchema>;
export type TurnTextCompleted = z.infer<typeof TurnTextCompletedSchema>;
