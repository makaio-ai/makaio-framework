/**
 * OpenAI Node Adapter Schema Exports
 *
 * Typed Zod schemas for all SDK events emitted by the OpenAI Node adapter.
 * These schemas enable type-safe event handling and validation.
 */

// Streaming events (OpenAI-specific)
export { ChunkEventSchema } from './chunk.js';
export type { ChunkEvent } from './chunk.js';
export { UsageEventSchema } from './usage.js';
export type { UsageEvent } from './usage.js';

// Tool events
export { ToolCallFunctionSchema, ToolCallSchema, ToolCallsEventSchema } from './tool-calls.js';
export type { ToolCall, ToolCallFunction, ToolCallsEvent } from './tool-calls.js';

// Message events
export { MessageCompleteEventSchema } from './message.js';
export type { MessageCompleteEvent } from './message.js';
export { ReasoningCompleteEventSchema, ReasoningDeltaEventSchema } from './reasoning.js';
export type { ReasoningCompleteEvent, ReasoningDeltaEvent } from './reasoning.js';

// Shared lifecycle and tool-lifecycle schemas (via stream-session shared package)
export {
  ToolStartedEventSchema,
  ToolCompletedEventSchema,
  AgentStartedEventSchema,
  AgentCompleteEventSchema,
  ErrorEventSchema,
} from '@makaio/ai-adapters-stream-session';
export type {
  ToolStartedEvent,
  ToolCompletedEvent,
  AgentStartedEvent,
  AgentCompleteEvent,
  ErrorEvent,
} from '@makaio/ai-adapters-stream-session';

// Turn state (canonical names from shared stream-session package)
export { StreamSessionTurnStateSchema, TurnStateChangedSchema } from '@makaio/ai-adapters-stream-session';
export type { StreamSessionTurnState, TurnStateChanged } from '@makaio/ai-adapters-stream-session';
