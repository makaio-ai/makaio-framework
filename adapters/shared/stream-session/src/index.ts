/**
 * Shared infrastructure for stream-based AI adapter implementations.
 *
 * Provides pure utility functions and types extracted from the Anthropic SDK
 * and OpenAI Node adapters to eliminate duplication.
 * @packageDocumentation
 */

export {
  applyApprovedArgs,
  boundToolResultContent,
  executeTool,
  extractToolCallPayload,
  filterToolsWithSchema,
  handleToolCalls,
  loadToolsFromRegistry,
  MAX_TOOL_RESULT_CONTENT_CHARS,
  toGlobalToolApproval,
} from './tool-handling/index.js';
export type {
  HandleToolCallsCallbacks,
  ToolCall,
  ToolCallPayload,
  ToolExecutionContextOverrides,
  ToolLifecycleEmitter,
  ToolRegistryLoadOptions,
  ToolResultBuilder,
} from './tool-handling/index.js';
export {
  AgentCompleteEventSchema,
  AgentStartedEventSchema,
  ErrorEventSchema,
  MessageCompleteEventSchema,
  MessageToolCallSchema,
  ReasoningCompleteEventSchema,
  ReasoningDeltaEventSchema,
  StreamSessionTurnStateSchema,
  ToolCallFunctionSchema,
  ToolCallSchema,
  ToolCallsEventSchema,
  ToolCompletedEventSchema,
  ToolStartedEventSchema,
  TurnStateChangedSchema,
} from './namespaces/index.js';
export type {
  AgentCompleteEvent,
  AgentStartedEvent,
  ErrorEvent,
  MessageCompleteEvent,
  MessageToolCall,
  ReasoningCompleteEvent,
  ReasoningDeltaEvent,
  StreamSessionTurnState,
  ToolCallFunction,
  ToolCallsEvent,
  ToolCompletedEvent,
  ToolStartedEvent,
  TurnStateChanged,
} from './namespaces/index.js';
export { BaseStreamSession } from './session/index.js';
export type { BaseSessionEmitEvent, StreamSdkEventEnvelope, StreamSessionConfig } from './session/index.js';
export { BaseStreamConnector } from './connector/index.js';
export type { BaseStreamConnectorConfig, StreamConnectorSession } from './connector/index.js';
export { BaseStreamAgent } from './agent/index.js';
export type { StreamAdapterSubjectSpec } from './agent/index.js';
