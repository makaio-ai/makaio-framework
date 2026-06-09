import { beforeAll, describe, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/index.js';
import { chunksDeepSeek_V3_2_ToolCall } from './fixtures/deekseep-v3_2/tool-call.js';
import { chunksGlm_4_5_Air_ToolCall } from './fixtures/glm-4-5-air/tool-call.js';
import { chunksGlm_4_6ToolCall } from './fixtures/glm-4-6-thinking/tool-call.js';
import { chunksNemotron_Nano_ToolCall } from './fixtures/nemotron-nano/tool-call.js';
import { chunksQwen_3_VL_ToolCall } from './fixtures/qwen-v3-tl/tool-call.js';
import { toAsyncIterable } from './shared.js';
import { processStream } from '../src/stream-bridge.js';
import { OpenAINodeConnectorNamespace, OpenAINodeConnectorSubjects } from '../src/index.js';
import { STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME } from '../src/structured-output-finalizer.js';
import type {
  SdkEvent,
  SdkEventMessage,
  MessageCompleteEvent,
  ToolCallsEvent,
  UsageEvent,
} from '../src/namespaces/index.js';

interface TestFixture {
  modelName: string;
  sample: ChatCompletionChunk[];
}

const fixtures: TestFixture[] = [
  { modelName: 'deepseek/deepseek-v3.2:thinking', sample: chunksDeepSeek_V3_2_ToolCall },
  { modelName: 'zai-org/GLM-4.5-Air:thinking', sample: chunksGlm_4_5_Air_ToolCall },
  { modelName: 'z-ai/glm-4.6:thinking', sample: chunksGlm_4_6ToolCall },
  { modelName: 'nvidia/nemotron-nano-12b-v2-vl', sample: chunksNemotron_Nano_ToolCall },
  { modelName: 'qwen3-vl-235b-a22b-thinking', sample: chunksQwen_3_VL_ToolCall },
];

describe('stream-bridge', () => {
  describe('Tool Call Normalization', () => {
    describe.each(fixtures)('$modelName', ({ modelName, sample }) => {
      let events: SdkEventMessage[] = [];
      const envelopes: SdkEvent[] = [];
      let messageComplete: MessageCompleteEvent | undefined;
      let toolCallsEvent: ToolCallsEvent | undefined;
      let usageEvent: UsageEvent | undefined;

      beforeAll(async () => {
        events = [];
        const bus = await OpenAINodeConnectorNamespace.scopedBus();

        bus.on(OpenAINodeConnectorSubjects.sdk.event, (context) => {
          envelopes.push(context.payload);
          events.push(context.payload.event);
        });

        await processStream(toAsyncIterable(sample), {
          bus,
          agentId: 'test-agent',
          adapterId: 'test-adapter',
          adapterName: 'openai-node',
          adapterSessionId: 'adapter-session-test',
          model: modelName,
        });

        messageComplete = events.find((e): e is MessageCompleteEvent => e.eventType === 'message_complete');
        toolCallsEvent = events.find((e): e is ToolCallsEvent => e.eventType === 'tool_calls');
        usageEvent = events.find((e): e is UsageEvent => e.eventType === 'usage');
      });

      it('emits message_complete event', () => {
        expect(messageComplete).toBeDefined();
      });

      it('produces valid tool_calls with parseable JSON arguments', () => {
        expect(messageComplete?.tool_calls).toBeDefined();
        expect(messageComplete!.tool_calls!.length).toBeGreaterThan(0);

        for (const tc of messageComplete!.tool_calls!) {
          expect(tc.id).toBeTruthy();
          expect(tc.type).toBe('function');
          expect(tc.function.name).toBe('write_file');
          expect(() => JSON.parse(tc.function.arguments)).not.toThrow();
        }
      });

      it('normalizes finish_reason to tool_calls', () => {
        // DeepSeek sends 'stop' but should be normalized to 'tool_calls'
        expect(messageComplete?.finish_reason).toBe('tool_calls');
      });

      it('extracts correct tool arguments', () => {
        const args = JSON.parse(messageComplete!.tool_calls![0].function.arguments) as Record<string, unknown>;

        // All fixtures write "HELLO" or "HELLO WORLD"
        expect(args.content).toMatch(/^HELLO/);

        // Nemotron uses 'file' instead of 'path' (model hallucination)
        const filePath = (args.path ?? args.file) as string;
        expect(filePath).toBeTruthy();
        expect(filePath).toMatch(/\.txt$/);
      });

      it('removes XML artifacts from content', () => {
        const content = messageComplete?.content ?? '';
        // Should not contain any XML tool call artifacts
        expect(content).not.toContain('<function_calls>');
        expect(content).not.toContain('</function_calls>');
        expect(content).not.toContain('<tool_call>');
        expect(content).not.toContain('</tool_call>');
        expect(content).not.toContain('<invoke');
        expect(content).not.toContain('<parameter');
      });

      it('emits tool_calls event before message_complete', () => {
        expect(toolCallsEvent).toBeDefined();

        const toolCallsIndex = events.findIndex((e) => e.eventType === 'tool_calls');
        const messageCompleteIndex = events.findIndex((e) => e.eventType === 'message_complete');

        expect(toolCallsIndex).toBeLessThan(messageCompleteIndex);
      });

      it('emits usage event with valid token counts', () => {
        expect(usageEvent).toBeDefined();
        expect(usageEvent!.prompt_tokens).toBeGreaterThan(0);
        expect(usageEvent!.completion_tokens).toBeGreaterThan(0);
        expect(usageEvent!.total_tokens).toBe(usageEvent!.prompt_tokens + usageEvent!.completion_tokens);
      });

      it('tool_calls event matches message_complete.tool_calls', () => {
        expect(toolCallsEvent?.toolCalls).toEqual(messageComplete?.tool_calls);
      });

      it('includes adapterSessionId metadata in sdk.event envelopes', () => {
        const completeEnvelope = envelopes.find((event) => event.event.eventType === 'message_complete');
        expect(completeEnvelope?.adapterSessionId).toBe('adapter-session-test');
      });
    });
  });

  it('keeps hidden finalizer tool calls out of public tool_calls events', async () => {
    const events: SdkEventMessage[] = [];
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const finalizerChunks: ChatCompletionChunk[] = [
      {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'openai-compatible',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-final',
                  type: 'function',
                  function: {
                    name: STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME,
                    arguments: '{"ok":true}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'openai-compatible',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
    ];

    bus.on(OpenAINodeConnectorSubjects.sdk.event, (context) => {
      events.push(context.payload.event);
    });

    await processStream(toAsyncIterable(finalizerChunks), {
      bus,
      agentId: 'test-agent',
      adapterId: 'test-adapter',
      adapterName: 'openai-node',
      adapterSessionId: 'adapter-session-test',
      model: 'openai-compatible',
      hiddenToolCallNames: [STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME],
    });

    const toolCallsEvent = events.find((event): event is ToolCallsEvent => event.eventType === 'tool_calls');
    const messageComplete = events.find(
      (event): event is MessageCompleteEvent => event.eventType === 'message_complete',
    );

    expect(toolCallsEvent).toBeUndefined();
    expect(messageComplete?.tool_calls).toEqual([
      {
        id: 'call-final',
        type: 'function',
        function: {
          name: STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME,
          arguments: '{"ok":true}',
        },
      },
    ]);
  });
});
