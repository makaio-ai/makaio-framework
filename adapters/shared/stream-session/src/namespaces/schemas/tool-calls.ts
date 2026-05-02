import { z } from 'zod';

/**
 * Public contract for a single tool-call function payload.
 *
 * Matches both the Anthropic ToolUseBlock.input structure and the
 * OpenAI ChatCompletionMessageToolCall.Function structure.
 */
export interface ToolCallFunction {
  /** Name of the function to call. */
  name: string;
  /** JSON-encoded arguments for the function. */
  arguments: string;
}

/**
 * Public contract for a single tool call.
 *
 * Contains only the fields common to both Anthropic and OpenAI adapters.
 * The Anthropic adapter extends this with `blockIndex`.
 */
export interface ToolCall {
  /** Unique identifier for this tool call. */
  id: string;
  /** Type of tool (always 'function' for now). */
  type: 'function';
  /** Function call details. */
  function: ToolCallFunction;
}

/**
 * Public contract for a tool-calls event.
 *
 * Emitted when the model requests tool / function execution.
 */
export interface ToolCallsEvent {
  /** Discriminator for tool call events. */
  eventType: 'tool_calls';
  /** Array of requested tool calls. */
  toolCalls: ToolCall[];
}

/**
 * Schema for a single tool call function.
 *
 * Matches both the Anthropic ToolUseBlock.input structure and the
 * OpenAI ChatCompletionMessageToolCall.Function structure.
 */
export const ToolCallFunctionSchema = z.object({
  /** Name of the function to call. */
  name: z.string(),
  /** JSON-encoded arguments for the function. */
  arguments: z.string(),
}) satisfies z.ZodType<ToolCallFunction>;

/**
 * Schema for a single tool call.
 *
 * Contains only the fields common to both Anthropic and OpenAI adapters.
 * The Anthropic adapter extends this with `blockIndex` via `.extend()`.
 *
 * Adapter-specific schemas may extend this via `.extend()`.
 */
export const ToolCallSchema = z.object({
  /** Unique identifier for this tool call. */
  id: z.string(),
  /** Type of tool (always 'function' for now). */
  type: z.literal('function'),
  /** Function call details. */
  function: ToolCallFunctionSchema,
}) satisfies z.ZodType<ToolCall>;

/**
 * Schema for a tool calls event.
 *
 * Emitted when the model requests tool / function execution.
 * Both adapters emit this event with the same structure, except the
 * Anthropic adapter's individual `ToolCall` entries also carry `blockIndex`.
 */
export const ToolCallsEventSchema = z.object({
  eventType: z.literal('tool_calls'),
  /** Array of tool calls requested by the model. */
  toolCalls: z.array(ToolCallSchema),
}) satisfies z.ZodType<ToolCallsEvent>;
