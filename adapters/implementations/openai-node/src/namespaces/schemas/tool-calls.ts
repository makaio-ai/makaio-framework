/**
 * Tool call schemas for the OpenAI Node adapter.
 *
 * The base schemas from `@makaio/ai-adapters-stream-session` match the OpenAI
 * ChatCompletionMessageFunctionToolCall structure exactly (no adapter-specific
 * extensions needed), so they are re-exported directly.
 */
export { ToolCallFunctionSchema, ToolCallSchema, ToolCallsEventSchema } from '@makaio/ai-adapters-stream-session';
export type { ToolCallFunction, ToolCall, ToolCallsEvent } from '@makaio/ai-adapters-stream-session';
