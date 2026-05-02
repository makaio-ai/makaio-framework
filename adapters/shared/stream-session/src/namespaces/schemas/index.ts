/**
 * Shared stream-session namespace schema exports.
 *
 * Base Zod schemas and inferred types that are common across all
 * stream-session adapter implementations (Anthropic SDK, OpenAI Node, etc.).
 *
 * Adapter-specific schemas live in the respective adapter packages and MUST
 * extend these base schemas rather than duplicating them.
 */

export { StreamSessionTurnStateSchema, TurnStateChangedSchema } from './turn-state.js';
export type { StreamSessionTurnState, TurnStateChanged } from './turn-state.js';
export { ReasoningCompleteEventSchema, ReasoningDeltaEventSchema } from './reasoning.js';
export type { ReasoningCompleteEvent, ReasoningDeltaEvent } from './reasoning.js';
export { ToolCallFunctionSchema, ToolCallSchema, ToolCallsEventSchema } from './tool-calls.js';
export type { ToolCall, ToolCallFunction, ToolCallsEvent } from './tool-calls.js';
export { MessageCompleteEventSchema, MessageToolCallSchema } from './message.js';
export type { MessageCompleteEvent, MessageToolCall } from './message.js';

// Shared lifecycle and tool-lifecycle schemas sourced from @makaio/ai-adapters-core.
// Re-exported here so adapter schema indexes can pull them from a single location
// rather than each adapter declaring the same import block.
export {
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  AgentStartedEventSchema,
  AgentCompleteEventSchema,
  ErrorEventSchema,
} from '@makaio/ai-adapters-core';
export type {
  ToolStartedEvent,
  ToolCompletedEvent,
  AgentStartedEvent,
  AgentCompleteEvent,
  ErrorEvent,
} from '@makaio/ai-adapters-core';
