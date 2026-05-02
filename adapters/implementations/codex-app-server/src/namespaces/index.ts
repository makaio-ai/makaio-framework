/**
 * Codex App-Server Adapter Namespace
 *
 * Defines internal bus events for the codex app-server adapter.
 * These events are emitted by the adapter and consumed by the core system.
 */

import { createAdapterNamespace, type ScopedBusFor } from '@makaio/ai-adapters-core';

// Import event schemas
import { ThreadStartedSchema, ThreadCompletedSchema } from './schemas/thread-lifecycle.js';
import {
  TurnStartedSchema,
  TurnCompletedSchema,
  TurnStepStartedSchema,
  TurnStepFinishedSchema,
  TurnStateChangedSchema,
} from './schemas/turn-lifecycle.js';
import { ItemStartedSchema, ItemCompletedSchema } from './schemas/item-lifecycle.js';
import { AgentMessageDeltaSchema, AgentMessageSchema } from './schemas/agent-message.js';
import {
  ExecCommandBeginSchema,
  ExecApprovalRequestSchema,
  ExecCommandOutputDeltaSchema,
  ExecCommandEndSchema,
} from './schemas/command-execution.js';
import { FileChangeApprovalRequestSchema, FileChangeOutputDeltaSchema } from './schemas/file-change.js';
import { ReasoningDeltaSchema, ReasoningSchema } from './schemas/reasoning.js';
import { TokenUsageSchema } from './schemas/token-usage.js';
import {
  DynamicToolCallBeginSchema,
  DynamicToolCallEndSchema,
  DynamicToolCallApprovalRequestSchema,
} from './schemas/dynamic-tool-call.js';

// Re-export all schemas and types
export { ThreadCompletedSchema, ThreadStartedSchema } from './schemas/thread-lifecycle.js';
export type { ThreadCompleted, ThreadStarted } from './schemas/thread-lifecycle.js';
export {
  CodexAppServerTurnStateSchema,
  TurnCompletedSchema,
  TurnStartedSchema,
  TurnStateChangedSchema,
  TurnStepFinishedSchema,
  TurnStepStartedSchema,
} from './schemas/turn-lifecycle.js';
export type {
  CodexAppServerTurnState,
  TurnCompleted,
  TurnStarted,
  TurnStateChanged,
  TurnStepFinished,
  TurnStepStarted,
} from './schemas/turn-lifecycle.js';
export { ItemCompletedSchema, ItemStartedSchema } from './schemas/item-lifecycle.js';
export type { ItemCompleted, ItemStarted } from './schemas/item-lifecycle.js';
export { AgentMessageDeltaSchema, AgentMessageSchema } from './schemas/agent-message.js';
export type { AgentMessage, AgentMessageDelta } from './schemas/agent-message.js';
export {
  ExecApprovalRequestSchema,
  ExecCommandBeginSchema,
  ExecCommandEndSchema,
  ExecCommandOutputDeltaSchema,
} from './schemas/command-execution.js';
export type {
  ExecApprovalRequest,
  ExecApprovalResponse,
  ExecCommandBegin,
  ExecCommandEnd,
  ExecCommandOutputDelta,
} from './schemas/command-execution.js';
export { FileChangeApprovalRequestSchema, FileChangeOutputDeltaSchema } from './schemas/file-change.js';
export type {
  FileChangeApprovalRequest,
  FileChangeApprovalResponse,
  FileChangeOutputDelta,
} from './schemas/file-change.js';
export { ReasoningDeltaSchema, ReasoningSchema } from './schemas/reasoning.js';
export type { Reasoning, ReasoningDelta } from './schemas/reasoning.js';
export { TokenUsageSchema } from './schemas/token-usage.js';
export type { TokenUsageEvent } from './schemas/token-usage.js';
export {
  DynamicToolCallApprovalRequestSchema,
  DynamicToolCallBeginSchema,
  DynamicToolCallEndSchema,
} from './schemas/dynamic-tool-call.js';
export type {
  DynamicToolCallApprovalRequest,
  DynamicToolCallApprovalResponse,
  DynamicToolCallBegin,
  DynamicToolCallEnd,
} from './schemas/dynamic-tool-call.js';

const namespace = 'adapter:codex-app-server' as const;

/**
 * Codex App-Server Adapter schemas.
 * Extracted as const to enable FilterPayload type computation via typeof.
 */
const codexAppServerSchemas = {
  // Thread lifecycle
  thread_started: ThreadStartedSchema,
  thread_completed: ThreadCompletedSchema,

  // Turn lifecycle
  turn_state_changed: TurnStateChangedSchema,
  turn_started: TurnStartedSchema,
  turn_completed: TurnCompletedSchema,
  turn_step_started: TurnStepStartedSchema,
  turn_step_finished: TurnStepFinishedSchema,

  // Item lifecycle
  item_started: ItemStartedSchema,
  item_completed: ItemCompletedSchema,

  // Agent messages
  agent_message_delta: AgentMessageDeltaSchema,
  agent_message: AgentMessageSchema,

  // Command execution
  exec_command_begin: ExecCommandBeginSchema,
  exec_approval_request: ExecApprovalRequestSchema,
  exec_command_output_delta: ExecCommandOutputDeltaSchema,
  exec_command_end: ExecCommandEndSchema,

  // File changes
  file_change_approval_request: FileChangeApprovalRequestSchema,
  file_change_output_delta: FileChangeOutputDeltaSchema,

  // Reasoning
  reasoning_delta: ReasoningDeltaSchema,
  reasoning: ReasoningSchema,

  // Usage
  token_usage: TokenUsageSchema,

  // Dynamic tool calls (experimental API)
  dynamic_tool_call_begin: DynamicToolCallBeginSchema,
  dynamic_tool_call_end: DynamicToolCallEndSchema,
  dynamic_tool_call_approval_request: DynamicToolCallApprovalRequestSchema,
} as const;

/**
 * Codex App-Server Adapter Namespace
 *
 * Defines the event subjects and schemas for internal bus communication
 * between the codex app-server adapter and the core system.
 */
export const CodexAppServerNamespace = createAdapterNamespace(namespace, codexAppServerSchemas);

/**
 * Typed subject literals for Codex App-Server adapter.
 * Use these constants to subscribe to specific message types with full type safety.
 */
export const CodexAppServerSubjects = CodexAppServerNamespace.subjects;

/** Scoped bus type for Codex App-Server adapter - includes FilterPayload for type-safe filtering */
export type CodexAppServerBus = ScopedBusFor<typeof CodexAppServerNamespace>;
