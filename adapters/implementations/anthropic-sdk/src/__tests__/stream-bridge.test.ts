/**
 * Stream Bridge integration tests.
 *
 * Exercises the full Anthropic event sequence translation against a real
 * (in-memory) bus instance.  No external processes, no mocked modules.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type {
  RawMessageStreamEvent,
  Usage,
  MessageDeltaUsage,
  RawMessageStartEvent,
  RawMessageDeltaEvent,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import { processStream } from '../stream-bridge.js';
import { AnthropicSdkConnectorNamespace, AnthropicSdkConnectorSubjects, type SdkEvent } from '../namespaces/index.js';
import type { StreamBridgeConfig } from '../types/index.js';

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link Usage} object for use in message_start events.
 * All nullable optional fields are set to `null` as the API would return them.
 * @param input_tokens - Number of prompt tokens.
 * @param cache_read_input_tokens - Nullable cache-read token count.
 * @param cache_creation_input_tokens - Nullable cache-write token count.
 * @returns A fully-populated Usage object.
 */
function makeUsage(
  input_tokens: number,
  cache_read_input_tokens: number | null = null,
  cache_creation_input_tokens: number | null = null,
): Usage {
  return {
    input_tokens,
    output_tokens: 1,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: null,
  };
}

/**
 * Build a minimal {@link MessageDeltaUsage} object for message_delta events.
 * @param output_tokens - Number of output tokens in this response.
 * @param cache_read_input_tokens - Nullable cumulative cache-read token count.
 * @param cache_creation_input_tokens - Nullable cumulative cache-write token count.
 * @returns A fully-populated MessageDeltaUsage object.
 */
function makeDeltaUsage(
  output_tokens: number,
  cache_read_input_tokens: number | null = null,
  cache_creation_input_tokens: number | null = null,
): MessageDeltaUsage {
  return {
    output_tokens,
    input_tokens: null,
    cache_read_input_tokens,
    cache_creation_input_tokens,
    server_tool_use: null,
  };
}

/**
 * Build a `message_start` stream event with the given usage.
 * @param id - Message ID for the event.
 * @param usage - Token usage to embed.
 * @returns A properly-typed message_start event.
 */
function makeMessageStart(id: string, usage: Usage): RawMessageStartEvent {
  return {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-sonnet-4-20250514',
      stop_reason: null,
      stop_details: null,
      stop_sequence: null,
      container: null,
      usage,
    },
  };
}

/**
 * Build a `message_delta` stream event with the given stop reason and usage.
 * @param stop_reason - Why the model stopped (e.g. 'end_turn', 'tool_use').
 * @param usage - Delta token usage.
 * @returns A properly-typed message_delta event.
 */
function makeMessageDelta(
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'pause_turn',
  usage: MessageDeltaUsage,
): RawMessageDeltaEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason, stop_sequence: null, stop_details: null, container: null },
    usage,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create an AsyncIterable that yields the provided events in order.
 * @param events - Raw Anthropic stream events to iterate.
 * @returns AsyncIterable suitable for passing to {@link processStream}.
 */
async function* makeStream(events: RawMessageStreamEvent[]): AsyncIterable<RawMessageStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

/** Minimal valid identity metadata for a stream bridge config. */
const BASE_CONFIG = {
  adapterName: 'anthropic-sdk',
  agentId: 'agent-test',
  adapterId: 'adapter-test',
  adapterSessionId: 'adapter-session-test',
  model: 'claude-sonnet-4-20250514',
} as const;

/**
 * Collect all sdk.event payloads emitted during a single {@link processStream} call.
 * @param events - Raw stream events to process.
 * @returns Ordered list of {@link SdkEvent} payloads.
 */
async function collectSdkEvents(events: RawMessageStreamEvent[]): Promise<SdkEvent[]> {
  const collected: SdkEvent[] = [];

  const scopedBus = MakaioBus.scoped(AnthropicSdkConnectorNamespace);
  const cleanup = MakaioBus.on(AnthropicSdkConnectorSubjects.sdk.event, ({ payload }) => {
    collected.push(payload as SdkEvent);
  });

  const config: StreamBridgeConfig = {
    ...BASE_CONFIG,
    bus: scopedBus,
  };

  try {
    await processStream(makeStream(events), config);
  } finally {
    cleanup();
  }

  return collected;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal text-only stream fixture: message_start → text block → message_stop.
 */
const textStreamFixture: RawMessageStreamEvent[] = [
  makeMessageStart('msg_01', makeUsage(25)),
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
  { type: 'content_block_stop', index: 0 },
  makeMessageDelta('end_turn', makeDeltaUsage(12)),
  { type: 'message_stop' },
];

/**
 * Tool-use stream fixture: single tool_use block.
 */
const toolUseStreamFixture: RawMessageStreamEvent[] = [
  makeMessageStart('msg_02', makeUsage(30)),
  {
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'read_file',
      caller: { type: 'direct' },
      input: {},
    },
  },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"/tmp/a"}' } },
  { type: 'content_block_stop', index: 0 },
  makeMessageDelta('tool_use', makeDeltaUsage(15)),
  { type: 'message_stop' },
];

/**
 * Extended-thinking stream fixture.
 */
const thinkingStreamFixture: RawMessageStreamEvent[] = [
  makeMessageStart('msg_03', makeUsage(20)),
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' carefully.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-think-1' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '', citations: null } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer.' } },
  { type: 'content_block_stop', index: 1 },
  makeMessageDelta('end_turn', makeDeltaUsage(20)),
  { type: 'message_stop' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processStream (stream-bridge)', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  describe('text-only response', () => {
    it('emits chunk events for each text_delta', async () => {
      const events = await collectSdkEvents(textStreamFixture);

      const chunks = events.filter((e) => e.event.eventType === 'chunk');
      expect(chunks).toHaveLength(2);
      expect(chunks[0].event).toMatchObject({
        eventType: 'chunk',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      });
      expect(chunks[1].event).toMatchObject({
        eventType: 'chunk',
        index: 0,
        delta: { type: 'text_delta', text: ' world' },
      });
    });

    it('emits a usage event with merged token counts', async () => {
      const events = await collectSdkEvents(textStreamFixture);

      const usage = events.find((e) => e.event.eventType === 'usage');
      expect(usage).toBeDefined();
      expect(usage?.event).toMatchObject({
        eventType: 'usage',
        prompt_tokens: 25,
        completion_tokens: 12,
        total_tokens: 37,
      });
    });

    it('emits message_complete with assembled content and finish_reason', async () => {
      const events = await collectSdkEvents(textStreamFixture);

      const complete = events.find((e) => e.event.eventType === 'message_complete');
      expect(complete).toBeDefined();
      expect(complete?.event).toMatchObject({
        eventType: 'message_complete',
        content: 'Hello world',
        finish_reason: 'end_turn',
      });
    });

    it('attaches correct identity metadata to events', async () => {
      const events = await collectSdkEvents(textStreamFixture);

      const complete = events.find((e) => e.event.eventType === 'message_complete');
      expect(complete).toMatchObject({
        adapterName: BASE_CONFIG.adapterName,
        agentId: BASE_CONFIG.agentId,
        adapterId: BASE_CONFIG.adapterId,
        adapterSessionId: BASE_CONFIG.adapterSessionId,
      });
    });

    it('does not emit tool_calls or reasoning events for a plain text stream', async () => {
      const events = await collectSdkEvents(textStreamFixture);

      const eventTypes = events.map((e) => e.event.eventType);
      expect(eventTypes).not.toContain('tool_calls');
      expect(eventTypes).not.toContain('reasoning_delta');
      expect(eventTypes).not.toContain('reasoning_complete');
    });
  });

  describe('tool-use response', () => {
    it('emits input_json_delta chunk events during tool input streaming', async () => {
      const events = await collectSdkEvents(toolUseStreamFixture);

      const jsonChunks = events.filter(
        (e) => e.event.eventType === 'chunk' && e.event.delta.type === 'input_json_delta',
      );
      expect(jsonChunks).toHaveLength(2);
    });

    it('emits a tool_calls event with parsed arguments', async () => {
      const events = await collectSdkEvents(toolUseStreamFixture);

      const toolCallsEvent = events.find((e) => e.event.eventType === 'tool_calls');
      expect(toolCallsEvent).toBeDefined();
      if (toolCallsEvent?.event.eventType !== 'tool_calls') return;

      const { toolCalls } = toolCallsEvent.event;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({
        id: 'toolu_01',
        blockIndex: 0,
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/tmp/a"}' },
      });
    });

    it('includes tool_calls in message_complete', async () => {
      const events = await collectSdkEvents(toolUseStreamFixture);

      const complete = events.find((e) => e.event.eventType === 'message_complete');
      expect(complete?.event).toMatchObject({
        eventType: 'message_complete',
        finish_reason: 'tool_use',
        tool_calls: [{ id: 'toolu_01', blockIndex: 0, type: 'function', function: { name: 'read_file' } }],
      });
    });

    it('defaults tool arguments to {} when input_json_delta is missing or blank', async () => {
      const noArgsFixture: RawMessageStreamEvent[] = [
        makeMessageStart('msg_tool_no_args', makeUsage(12)),
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_no_args',
            name: 'noop',
            caller: { type: 'direct' },
            input: {},
          },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '   ' } },
        { type: 'content_block_stop', index: 0 },
        makeMessageDelta('tool_use', makeDeltaUsage(4)),
        { type: 'message_stop' },
      ];

      const events = await collectSdkEvents(noArgsFixture);
      const toolCallsEvent = events.find((e) => e.event.eventType === 'tool_calls');
      expect(toolCallsEvent).toBeDefined();
      if (toolCallsEvent?.event.eventType !== 'tool_calls') return;
      expect(toolCallsEvent.event.toolCalls[0]?.function.arguments).toBe('{}');
    });
  });

  describe('thinking/reasoning response', () => {
    it('emits reasoning_delta events for thinking_delta chunks', async () => {
      const events = await collectSdkEvents(thinkingStreamFixture);

      const deltas = events.filter((e) => e.event.eventType === 'reasoning_delta');
      expect(deltas).toHaveLength(2);
      expect(deltas[0].event).toMatchObject({ eventType: 'reasoning_delta', content: 'Let me think' });
      expect(deltas[1].event).toMatchObject({ eventType: 'reasoning_delta', content: ' carefully.' });
    });

    it('emits a reasoning_complete event with fully assembled thinking content', async () => {
      const events = await collectSdkEvents(thinkingStreamFixture);

      const complete = events.find((e) => e.event.eventType === 'reasoning_complete');
      expect(complete).toBeDefined();
      expect(complete?.event).toMatchObject({
        eventType: 'reasoning_complete',
        content: 'Let me think carefully.',
        signature: 'sig-think-1',
      });
    });

    it('includes thinking_delta chunks alongside text chunks', async () => {
      const events = await collectSdkEvents(thinkingStreamFixture);

      const allChunks = events.filter((e) => e.event.eventType === 'chunk');
      const thinkingChunks = allChunks.filter(
        (e) => e.event.eventType === 'chunk' && e.event.delta.type === 'thinking_delta',
      );
      const textChunks = allChunks.filter((e) => e.event.eventType === 'chunk' && e.event.delta.type === 'text_delta');
      expect(thinkingChunks.length).toBeGreaterThan(0);
      expect(textChunks.length).toBeGreaterThan(0);
    });

    it('includes reasoning in message_complete', async () => {
      const events = await collectSdkEvents(thinkingStreamFixture);

      const complete = events.find((e) => e.event.eventType === 'message_complete');
      expect(complete?.event).toMatchObject({
        eventType: 'message_complete',
        content: 'Answer.',
        reasoning: 'Let me think carefully.',
      });
    });
  });

  describe('usage tracking', () => {
    it('defaults cache token fields to 0 when the provider does not include them', async () => {
      const events = await collectSdkEvents(textStreamFixture);

      const usage = events.find((e) => e.event.eventType === 'usage');
      expect(usage?.event).toBeDefined();
      // Cache fields are always present, defaulting to 0 when not sent by the API.
      expect(usage?.event).toMatchObject({
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
    });

    it('includes cache token fields when provider sends them', async () => {
      const cacheFixture: RawMessageStreamEvent[] = [
        makeMessageStart('msg_cache', makeUsage(10, 5, 3)),
        makeMessageDelta('end_turn', makeDeltaUsage(8)),
        { type: 'message_stop' },
      ];

      const events = await collectSdkEvents(cacheFixture);

      const usage = events.find((e) => e.event.eventType === 'usage');
      expect(usage?.event).toMatchObject({
        eventType: 'usage',
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      });
    });
  });

  describe('mixed content (text + tool_use)', () => {
    it('tracks text and tool blocks independently', async () => {
      const mixedFixture: RawMessageStreamEvent[] = [
        makeMessageStart('msg_mixed', makeUsage(40)),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'content_block_start',
          index: 1,
          content_block: {
            type: 'tool_use',
            id: 'toolu_02',
            name: 'bash',
            caller: { type: 'direct' },
            input: {},
          },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } },
        { type: 'content_block_stop', index: 1 },
        makeMessageDelta('tool_use', makeDeltaUsage(20)),
        { type: 'message_stop' },
      ];

      const events = await collectSdkEvents(mixedFixture);

      const complete = events.find((e) => e.event.eventType === 'message_complete');
      expect(complete?.event).toMatchObject({
        eventType: 'message_complete',
        content: 'Checking.',
        finish_reason: 'tool_use',
        tool_calls: [{ id: 'toolu_02', blockIndex: 1, type: 'function', function: { name: 'bash' } }],
      });
    });
  });
});
