/* eslint max-lines: ["error", { "max": 300 }] */
/**
 * Stream Bridge - Owns Anthropic stream processing and event emission.
 *
 * Translates Anthropic's block-indexed event sequence:
 *   message_start → content_block_start → N × content_block_delta
 *   → content_block_stop → message_delta → message_stop
 * into normalized semantic bus events (chunk, reasoning_delta,
 * reasoning_complete, usage, tool_calls, message_complete).
 */
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { AnthropicSdkConnectorSubjects, type SdkEventMessage } from './namespaces/index.js';
import type { StreamBridgeConfig, ToolCallAccumulator } from './types/index.js';
import { mergeDeltaUsage, mergeInitialUsage, type MergedUsage } from './utils/usage.js';

/** Accumulated state for a single Anthropic content block during streaming. */
interface ContentBlockState {
  /** Discriminates how the block's accumulated data is interpreted. */
  type: 'text' | 'tool_use' | 'thinking';
  text?: string;
  toolId?: string;
  toolName?: string;
  jsonAccumulator?: string;
  thinking?: string;
  /** Extended-thinking signature stored per resolved design (block.metadata.signature). */
  signature?: string;
}
/** Internal aggregation state for a single streaming turn. */
interface StreamState {
  /** Accumulated plain-text content across all text blocks. */
  content: string;
  /** Accumulated thinking content across all thinking blocks. */
  reasoning: string;
  /** Reasoning signature captured from thinking block deltas. */
  reasoningSignature?: string;
  /** Stop reason received from message_delta. */
  stopReason: string | null;
  /** Merged token usage (populated on message_start, updated on message_delta). */
  usage: MergedUsage | null;
  /** Finalized tool call accumulators (harvested on content_block_stop). */
  toolCalls: ToolCallAccumulator[];
  /** Live content block tracking keyed by Anthropic block index. */
  contentBlocks: Map<number, ContentBlockState>;
}
/** Typed emitter for normalized sdk.event messages. */
type EventEmitter = (event: SdkEventMessage) => Promise<void>;

/**
 * Create a fresh stream processing state object.
 * @returns Empty initial state.
 */
function createStreamState(): StreamState {
  return {
    content: '',
    reasoning: '',
    reasoningSignature: undefined,
    stopReason: null,
    usage: null,
    toolCalls: [],
    contentBlocks: new Map(),
  };
}

/**
 * Build an EventEmitter bound to the given bus and identity metadata.
 * @param config - Stream bridge configuration providing bus and identity.
 * @param metadata - Envelope metadata attached to every emitted event.
 * @returns Async emitter for SdkEventMessage payloads.
 */
function buildEventEmitter(
  config: StreamBridgeConfig,
  metadata: { adapterName: string; agentId: string; adapterId: string; adapterSessionId?: string },
): EventEmitter {
  return async (event) => {
    const correlatedEvent =
      event.eventType === 'usage' && config.requestCorrelation !== undefined
        ? {
            ...event,
            llmCallId: config.requestCorrelation.llmCallId,
            ...(config.requestCorrelation.executionId !== undefined
              ? { executionId: config.requestCorrelation.executionId }
              : {}),
            ...(config.requestCorrelation.frameId !== undefined ? { frameId: config.requestCorrelation.frameId } : {}),
          }
        : event;
    await config.bus.emit(AnthropicSdkConnectorSubjects.sdk.event, { event: correlatedEvent, ...metadata });
  };
}

/**
 * Handle content_block_delta: accumulate delta content and emit streaming events.
 * @param index - Content block index from the stream event.
 * @param event - The full content_block_delta event.
 * @param state - Mutable stream state.
 * @param emitEvent - Normalized event emitter.
 */
async function handleContentBlockDelta(
  index: number,
  event: RawMessageStreamEvent & { type: 'content_block_delta' },
  state: StreamState,
  emitEvent: EventEmitter,
): Promise<void> {
  const block = state.contentBlocks.get(index);
  const rawDelta = event.delta;

  if (rawDelta.type === 'text_delta') {
    if (block) block.text = (block.text ?? '') + rawDelta.text;
    state.content += rawDelta.text;
    await emitEvent({ eventType: 'chunk', index, delta: { type: 'text_delta', text: rawDelta.text } });
  } else if (rawDelta.type === 'thinking_delta') {
    if (block) block.thinking = (block.thinking ?? '') + rawDelta.thinking;
    state.reasoning += rawDelta.thinking;
    await emitEvent({ eventType: 'reasoning_delta', content: rawDelta.thinking });
    await emitEvent({ eventType: 'chunk', index, delta: { type: 'thinking_delta', thinking: rawDelta.thinking } });
  } else if (rawDelta.type === 'input_json_delta') {
    if (block) block.jsonAccumulator = (block.jsonAccumulator ?? '') + rawDelta.partial_json;
    await emitEvent({
      eventType: 'chunk',
      index,
      delta: { type: 'input_json_delta', partial_json: rawDelta.partial_json },
    });
  } else if (rawDelta.type === 'signature_delta') {
    // Signature is an extended-thinking implementation detail; stored in block state only.
    if (block) block.signature = (block.signature ?? '') + rawDelta.signature;
  }
  // CitationsDelta is intentionally unhandled: no bus schema is defined for citations.
}

/**
 * Handle content_block_stop: finalize the block and harvest completed tool calls.
 * @param index - Content block index from the stream event.
 * @param state - Mutable stream state.
 */
function handleContentBlockStop(index: number, state: StreamState): void {
  const block = state.contentBlocks.get(index);
  if (!block) return;

  if (block.type === 'thinking' && block.signature && state.reasoningSignature === undefined) {
    state.reasoningSignature = block.signature;
  }

  if (block.type === 'tool_use' && block.toolId && block.toolName !== undefined) {
    state.toolCalls.push({
      id: block.toolId,
      name: block.toolName,
      arguments: block.jsonAccumulator?.trim() ? block.jsonAccumulator : '{}',
      blockIndex: index,
    });
  }

  state.contentBlocks.delete(index);
}

/**
 * Emit final semantic events once the stream has ended.
 * @param state - Final aggregated stream state.
 * @param emitEvent - Normalized event emitter.
 */
async function emitFinalEvents(state: StreamState, emitEvent: EventEmitter): Promise<void> {
  if (state.usage) {
    const { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens } = state.usage;
    await emitEvent({
      eventType: 'usage',
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      cache_read_input_tokens: cacheReadInputTokens ?? 0,
      cache_creation_input_tokens: cacheCreationInputTokens ?? 0,
    });
  }

  const toolCallPayload =
    state.toolCalls.length > 0
      ? state.toolCalls.map((tc) => ({
          id: tc.id,
          blockIndex: tc.blockIndex,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        }))
      : undefined;

  if (toolCallPayload) {
    await emitEvent({ eventType: 'tool_calls', toolCalls: toolCallPayload });
  }

  if (state.reasoning) {
    await emitEvent({
      eventType: 'reasoning_complete',
      content: state.reasoning,
      ...(state.reasoningSignature !== undefined ? { signature: state.reasoningSignature } : {}),
    });
  }

  await emitEvent({
    eventType: 'message_complete',
    content: state.content || null,
    reasoning: state.reasoning || undefined,
    tool_calls: toolCallPayload,
    finish_reason:
      (state.stopReason as 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn') ?? null,
  });
}

/**
 * Processes an Anthropic message stream and emits normalized bus events.
 *
 * Translates Anthropic's block-based streaming protocol (message_start →
 * content_block_start → content_block_delta → content_block_stop →
 * message_delta → message_stop) into semantic adapter events.
 *
 * Emits to bus as the stream progresses:
 * - sdk.raw: Each raw Anthropic event (observability)
 * - sdk.event: Semantic events — chunk, reasoning_delta, reasoning_complete, usage, tool_calls, message_complete
 * @param stream - The Anthropic streaming response.
 * @param config - Bridge configuration with bus, agent identity, and model.
 */
export async function processStream(
  stream: AsyncIterable<RawMessageStreamEvent>,
  config: StreamBridgeConfig,
): Promise<void> {
  const state = createStreamState();
  const metadata = { adapterName: config.adapterName, agentId: config.agentId, adapterId: config.adapterId };
  const metadataWithSession = config.adapterSessionId
    ? { ...metadata, adapterSessionId: config.adapterSessionId }
    : metadata;
  const emitEvent = buildEventEmitter(config, metadataWithSession);

  for await (const event of stream) {
    config.logLowLevelEvent?.(event);
    await config.bus.emit(AnthropicSdkConnectorSubjects.sdk.raw, event);

    switch (event.type) {
      case 'message_start':
        state.usage = mergeInitialUsage(event.message.usage);
        break;

      case 'content_block_start': {
        const cb = event.content_block;
        if (cb.type === 'text') {
          state.contentBlocks.set(event.index, { type: 'text', text: '' });
        } else if (cb.type === 'tool_use') {
          state.contentBlocks.set(event.index, {
            type: 'tool_use',
            toolId: cb.id,
            toolName: cb.name,
            jsonAccumulator: '',
          });
        } else if (cb.type === 'thinking') {
          state.contentBlocks.set(event.index, { type: 'thinking', thinking: '', signature: '' });
        }
        // redacted_thinking and server_tool_use are not tracked
        break;
      }

      case 'content_block_delta':
        await handleContentBlockDelta(event.index, event, state, emitEvent);
        break;

      case 'content_block_stop':
        handleContentBlockStop(event.index, state);
        break;

      case 'message_delta':
        state.stopReason = event.delta.stop_reason ?? null;
        if (state.usage) state.usage = mergeDeltaUsage(state.usage, event.usage);
        break;

      case 'message_stop':
        // Terminal event — final events are emitted after the loop.
        break;
    }
  }

  await emitFinalEvents(state, emitEvent);
}
