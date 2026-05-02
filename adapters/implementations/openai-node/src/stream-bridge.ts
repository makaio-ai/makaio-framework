// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 450 }] */
/**
 * Stream Bridge - Owns OpenAI stream processing, normalization, and event emission.
 *
 * Responsibilities:
 * - Iterate OpenAI streaming response
 * - Emit raw chunks to sdk.raw (observability)
 * - Aggregate content, reasoning, tool calls
 * - Apply model-agnostic normalizations (GLM JSON fix, DeepSeek XML extraction)
 * - Emit normalized semantic events to sdk.event
 *
 * Pattern: Connector creates stream, stream-bridge owns processing.
 * Connector listens for message_complete event to get normalized result.
 */
import type { ChatCompletionChunk, ChatCompletionMessageFunctionToolCall } from 'openai/resources/index.js';
import { OpenAINodeConnectorSubjects, type SdkEventMessage } from './namespaces/index.js';
import type { StreamBridgeConfig, ToolCallAccumulator } from './types/index.js';

/**
 * Convert accumulators to complete tool calls.
 * @param accumulators - Tool call accumulators to convert
 * @returns Complete tool call objects
 */
function buildToolCalls(accumulators: ToolCallAccumulator[]): ChatCompletionMessageFunctionToolCall[] {
  return accumulators.map((acc) => ({
    id: acc.id,
    type: 'function' as const,
    function: { name: acc.name, arguments: acc.arguments },
  }));
}

/**
 * Update tool call accumulator with delta data.
 * @param accumulators - Array of tool call accumulators
 * @param delta - Delta data from streaming chunk
 */
function updateToolCallAccumulator(
  accumulators: ToolCallAccumulator[],
  delta: ChatCompletionChunk.Choice.Delta.ToolCall,
): void {
  const index = delta.index;

  if (!accumulators[index]) {
    accumulators[index] = {
      id: delta.id ?? '',
      name: delta.function?.name ?? '',
      arguments: '',
    };
  }

  const accumulator = accumulators[index];
  if (delta.id) accumulator.id = delta.id;
  if (delta.function?.name) accumulator.name = delta.function.name;
  if (delta.function?.arguments) {
    const current = accumulator.arguments;
    const incoming = delta.function.arguments;
    // Nemotron quirk: final chunk repeats full arguments instead of delta
    // Detect: accumulated ends with '}' (complete JSON) and incoming starts with '{' (new JSON)
    // Exception: GLM sends '{}' as trailing chunk - don't replace with empty object
    const isRepeatNotTrailingEmpty = current.endsWith('}') && incoming.startsWith('{') && incoming !== '{}';
    if (isRepeatNotTrailingEmpty) {
      // Final chunk has complete args - replace instead of concatenate
      accumulator.arguments = incoming;
    } else {
      accumulator.arguments += incoming;
    }
  }
}

/**
 * Parse DeepSeek-style XML tool calls from content.
 * Format: `<function_calls><invoke name="..."><parameter name="..." string="true">value</parameter></invoke></function_calls>`
 * @param content - Raw content potentially containing XML tool calls
 * @returns Parsed tool calls or empty array if parsing fails
 */
function parseXmlToolCalls(content: string): ChatCompletionMessageFunctionToolCall[] {
  const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];

  // Extract function_calls block
  const functionCallsMatch = content.match(/<function_calls>([\s\S]*?)<\/function_calls>/);
  if (!functionCallsMatch) return [];

  const functionCallsContent = functionCallsMatch[1];

  // Extract each invoke block
  const invokeRegex = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let invokeMatch;
  let callIndex = 0;

  while ((invokeMatch = invokeRegex.exec(functionCallsContent)) !== null) {
    const functionName = invokeMatch[1];
    const invokeContent = invokeMatch[2];

    // Extract parameters
    const params: Record<string, unknown> = {};
    const paramRegex = /<parameter\s+name="([^"]+)"(?:\s+string="true")?>([^<]*)<\/parameter>/g;
    let paramMatch;

    while ((paramMatch = paramRegex.exec(invokeContent)) !== null) {
      const paramName = paramMatch[1];
      const paramValue = paramMatch[2];
      params[paramName] = paramValue;
    }

    toolCalls.push({
      id: `xml_call_${callIndex++}`,
      type: 'function',
      function: {
        name: functionName,
        arguments: JSON.stringify(params),
      },
    });
  }

  return toolCalls;
}

/**
 * Parse GLM-4.5-Air-style XML tool calls from content.
 * Format: `<tool_call>function_name\n<arg_key>key</arg_key>\n<arg_value>value</arg_value>\n</tool_call>`
 * @param content - Raw content potentially containing XML tool calls
 * @returns Parsed tool calls or empty array if parsing fails
 */
function parseGlmAirXml(content: string): ChatCompletionMessageFunctionToolCall[] {
  const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let toolCallMatch;
  let callIndex = 0;

  while ((toolCallMatch = toolCallRegex.exec(content)) !== null) {
    const toolCallContent = toolCallMatch[1];
    const functionName = toolCallContent.trim().split('\n')[0]?.trim();
    if (!functionName) continue;

    const params: Record<string, unknown> = {};
    const keys = Array.from(toolCallContent.matchAll(/<arg_key>([^<]*)<\/arg_key>/g), (m) => m[1]);
    const values = Array.from(toolCallContent.matchAll(/<arg_value>([^<]*)<\/arg_value>/g), (m) => m[1]);

    for (let i = 0; i < Math.min(keys.length, values.length); i++) {
      params[keys[i]] = values[i];
    }

    toolCalls.push({
      id: `glm_air_call_${callIndex++}`,
      type: 'function',
      function: { name: functionName, arguments: JSON.stringify(params) },
    });
  }

  return toolCalls;
}

/** Result of normalizing a streaming turn response. */
interface NormalizedResult {
  content: string;
  reasoning: string;
  toolCalls: ChatCompletionMessageFunctionToolCall[];
  finishReason: string | null;
}

/** Internal state for stream processing aggregation. */
interface StreamState {
  content: string;
  reasoning: string;
  finishReason: string | null;
  usage: { promptTokens: number; completionTokens: number } | null;
  toolCallAccumulators: ToolCallAccumulator[];
}

/**
 * Create initial stream processing state.
 * @returns Fresh state object
 */
function createStreamState(): StreamState {
  return {
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    toolCallAccumulators: [],
  };
}

/**
 * Extract usage from chunk if present.
 * @param chunk - Chunk to extract usage from
 * @returns Usage object or null
 */
function extractUsage(chunk: ChatCompletionChunk): { promptTokens: number; completionTokens: number } | null {
  if (!chunk.usage) return null;
  return {
    promptTokens: chunk.usage.prompt_tokens,
    completionTokens: chunk.usage.completion_tokens,
  };
}

/**
 * Apply model-agnostic normalizations to tool calls and content.
 * Detects quirks by content patterns, not model names.
 * @param content - Raw content from stream
 * @param reasoning - Reasoning content from stream (e.g., from reasoning_delta events)
 * @param toolCalls - Aggregated tool calls from stream
 * @param finishReason - Finish reason from stream
 * @returns Normalized result with cleaned content, reasoning, and tool calls
 */
function normalizeResult(
  content: string,
  reasoning: string,
  toolCalls: ChatCompletionMessageFunctionToolCall[],
  finishReason: string | null,
): NormalizedResult {
  let normalizedContent = content;
  let normalizedReasoning = reasoning;
  let normalizedToolCalls = toolCalls;
  let normalizedFinishReason = finishReason;

  // Reasoning-model normalization: extract <think>/<thinking> blocks from content
  // Pattern: model embeds chain-of-thought reasoning in content (Nemotron, QwQ, etc.)
  const thinkMatch = normalizedContent.match(/^<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>\s*/);
  if (thinkMatch) {
    const extractedReasoning = thinkMatch[1].trim();
    normalizedContent = normalizedContent.slice(thinkMatch[0].length).trim();
    // Merge with existing reasoning (extracted comes first, then streamed)
    normalizedReasoning = normalizedReasoning ? `${extractedReasoning}\n\n${normalizedReasoning}` : extractedReasoning;
  }

  // GLM-style normalization: strip trailing {} from tool call arguments
  // Pattern: model sends args in one chunk, then sends "{}" in follow-up
  // Result after aggregation: '{"path":"...","content":"HELLO"}{}'
  normalizedToolCalls = normalizedToolCalls.map((tc) => {
    if (/\}\s*\{\s*\}$/.test(tc.function.arguments)) {
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: tc.function.arguments.replace(/\}\s*\{\s*\}$/, '}'),
        },
      };
    }
    return tc;
  });

  // DeepSeek-style normalization: extract XML tool calls from content
  // Pattern: model outputs <function_calls> XML in content with finish_reason='stop'
  if (
    normalizedContent.includes('<function_calls>') &&
    normalizedFinishReason === 'stop' &&
    normalizedToolCalls.length === 0
  ) {
    const parsed = parseXmlToolCalls(normalizedContent);
    if (parsed.length > 0) {
      normalizedToolCalls = parsed;
      normalizedFinishReason = 'tool_calls';
      // Remove XML from content, keep any text before/after
      normalizedContent = normalizedContent.replace(/<function_calls>[\s\S]*<\/function_calls>/, '').trim();
    }
  }

  // GLM-4.5-Air normalization: extract XML tool calls from content when tool_calls array has empty args
  // Pattern: model outputs <tool_call> XML in content, sends empty tool_calls array with arguments='{}'
  if (
    normalizedFinishReason === 'tool_calls' &&
    normalizedToolCalls.length > 0 &&
    normalizedToolCalls.every((tc) => tc.function.arguments === '{}') &&
    normalizedContent.includes('<tool_call>')
  ) {
    const parsed = parseGlmAirXml(normalizedContent);
    if (parsed.length > 0) {
      normalizedToolCalls = parsed;
      // Remove XML from content, keep any text before/after
      normalizedContent = normalizedContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
    }
  }

  return {
    content: normalizedContent,
    reasoning: normalizedReasoning,
    toolCalls: normalizedToolCalls,
    finishReason: normalizedFinishReason,
  };
}

/** Event emitter function type for stream processing. */
type EventEmitter = (event: SdkEventMessage) => Promise<void>;

/**
 * Process a choice delta and accumulate state.
 * @param choice - Stream choice containing delta
 * @param chunk - Full chunk for usage extraction
 * @param state - Mutable aggregation state
 * @param emitEvent - Event emitter function
 */
async function processChoiceDelta(
  choice: ChatCompletionChunk.Choice,
  chunk: ChatCompletionChunk,
  state: StreamState,
  emitEvent: EventEmitter,
): Promise<void> {
  const delta = choice.delta;
  if (choice.finish_reason !== null) state.finishReason = choice.finish_reason;

  if (delta.content) state.content += delta.content;

  // Accumulate reasoning (extended field from OpenAI-compatible APIs)
  // DeepSeek uses reasoning_content, others may use reasoning
  const reasoningDelta =
    (delta as { reasoning?: string; reasoning_content?: string }).reasoning ||
    (delta as { reasoning?: string; reasoning_content?: string }).reasoning_content;
  if (reasoningDelta) {
    state.reasoning += reasoningDelta;
    await emitEvent({ eventType: 'reasoning_delta', content: reasoningDelta });
  }

  if (delta.tool_calls) {
    for (const toolCallDelta of delta.tool_calls) {
      updateToolCallAccumulator(state.toolCallAccumulators, toolCallDelta);
    }
  }

  // Handle usage in chunk (some providers include it in chunks with choices)
  if (chunk.usage && !state.usage) {
    state.usage = extractUsage(chunk);
    if (state.usage) {
      await emitEvent({
        eventType: 'usage',
        prompt_tokens: state.usage.promptTokens,
        completion_tokens: state.usage.completionTokens,
        total_tokens: state.usage.promptTokens + state.usage.completionTokens,
      });
    }
  }
}

/**
 * Emit final events after stream completes.
 * @param state - Final aggregation state
 * @param emitEvent - Event emitter function
 */
async function emitFinalEvents(state: StreamState, emitEvent: EventEmitter): Promise<void> {
  const rawToolCalls = buildToolCalls(state.toolCallAccumulators);
  const normalized = normalizeResult(state.content, state.reasoning, rawToolCalls, state.finishReason);

  if (normalized.toolCalls.length > 0) {
    await emitEvent({ eventType: 'tool_calls', toolCalls: normalized.toolCalls });
  }

  await emitEvent({
    eventType: 'message_complete',
    content: normalized.content || null,
    reasoning: normalized.reasoning || undefined,
    tool_calls: normalized.toolCalls.length > 0 ? normalized.toolCalls : undefined,
    finish_reason: normalized.finishReason as
      | 'stop'
      | 'length'
      | 'tool_calls'
      | 'content_filter'
      | 'function_call'
      | null,
  });

  if (normalized.reasoning) {
    await emitEvent({ eventType: 'reasoning_complete', content: normalized.reasoning });
  }
}

/**
 * Process an OpenAI streaming response.
 *
 * Emits events to bus as stream progresses:
 * - sdk.raw: Each raw chunk (for observability)
 * - sdk.event: Semantic events (chunk, reasoning_delta, usage, tool_calls, message_complete)
 *
 * Applies normalizations before emitting final events:
 * - GLM: Strips trailing `\{\}` from tool call arguments
 * - DeepSeek: Extracts XML tool calls from content
 * @param stream - OpenAI streaming response
 * @param config - Bus and metadata configuration
 */
export async function processStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  config: StreamBridgeConfig,
): Promise<void> {
  const state = createStreamState();
  const metadata = {
    adapterName: config.adapterName,
    agentId: config.agentId,
    adapterId: config.adapterId,
    ...(config.adapterSessionId ? { adapterSessionId: config.adapterSessionId } : {}),
  };

  const emitRaw = async (chunk: ChatCompletionChunk): Promise<void> => {
    await config.bus.emit(OpenAINodeConnectorSubjects.sdk.raw, {
      ...chunk,
      ...metadata,
    });
  };

  const emitEvent: EventEmitter = async (event) => {
    await config.bus.emit(OpenAINodeConnectorSubjects.sdk.event, {
      event,
      ...metadata,
    });
  };

  for await (const chunk of stream) {
    config.logLowLevelEvent?.(chunk);
    await emitRaw(chunk);

    const choice = chunk.choices[0];
    if (!choice) {
      // Handle usage-only chunk (empty choices array on final chunk)
      const usage = extractUsage(chunk);
      if (usage && !state.usage) {
        state.usage = usage;
        await emitEvent({
          eventType: 'usage',
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.promptTokens + usage.completionTokens,
        });
      }
      continue;
    }

    await processChoiceDelta(choice, chunk, state, emitEvent);
  }
  await emitFinalEvents(state, emitEvent);
}
