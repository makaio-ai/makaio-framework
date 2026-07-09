import { afterEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { FactoryUsageCorrelationHeaders, MessageHandle } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { AnthropicSdkSession } from '../session.js';
import type { AnthropicSdkSessionConfig } from '../types/index.js';
import type { AnthropicSdkConnectorTurn } from '../turn.js';
import { AnthropicSdkConnectorNamespace, AnthropicSdkConnectorSubjects, type UsageEvent } from '../namespaces/index.js';

class ExposedAnthropicSession extends AnthropicSdkSession {
  public async invokeProvider(handle: MessageHandle): Promise<void> {
    const turn = {
      getMessageHandle: () => handle,
      markStepStarted: async () => {},
      markStepFinished: async () => {},
    } as AnthropicSdkConnectorTurn;
    await super.executeApiCall(turn, new AbortController().signal, 'adapter-session-1');
  }
}

async function* messageStream(): AsyncGenerator<RawMessageStreamEvent> {
  yield {
    type: 'message_start',
    message: {
      id: 'message-provider-1',
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'claude-test',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    },
  } as unknown as RawMessageStreamEvent;
  yield {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  } as unknown as RawMessageStreamEvent;
  yield { type: 'message_stop' };
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('Anthropic Factory Gateway request correlation', () => {
  it('sends allowlisted headers with a distinct matching LLM call ID for every request', async () => {
    const bus = await AnthropicSdkConnectorNamespace.scopedBus();
    const create = vi.fn(async (_body: unknown, _options?: unknown) => messageStream());
    const usages: UsageEvent[] = [];
    bus.on(AnthropicSdkConnectorSubjects.sdk.event, ({ payload }) => {
      if (payload.event.eventType === 'usage') usages.push(payload.event);
    });
    const config: AnthropicSdkSessionConfig = {
      bus,
      adapterId: 'adapter-1',
      adapterName: 'anthropic-sdk',
      agentId: 'agent-1',
      sessionId: 'session-runtime',
      cwd: '/tmp',
      model: 'claude-test',
      env: {},
      client: { messages: { create } } as unknown as Anthropic,
      anthropicTools: [],
      requestCorrelationHeaders: 'factory-v1',
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }),
    };
    const session = new ExposedAnthropicSession(config);
    const firstHandle = new MessageHandle(
      'message-runtime',
      { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      'enqueue',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      {
        sessionId: 'stale-session',
        turnId: 'turn-1',
        executionId: 'execution-1',
        frameId: 'frame-1',
      },
    );
    const secondHandle = new MessageHandle(
      'message-runtime-2',
      { role: 'user', message: 'again', blocks: [{ type: 'text', content: 'again' }] },
      'enqueue',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      {
        sessionId: 'stale-session',
        turnId: 'turn-2',
        executionId: 'execution-1',
        frameId: 'frame-1',
      },
    );

    await session.invokeProvider(firstHandle);
    await session.invokeProvider(secondHandle);

    const firstOptions = create.mock.calls[0]?.[1] as { headers: Record<string, string> };
    const secondOptions = create.mock.calls[1]?.[1] as { headers: Record<string, string> };
    expect(firstOptions.headers).toMatchObject({
      [FactoryUsageCorrelationHeaders.sessionId]: 'session-runtime',
      [FactoryUsageCorrelationHeaders.turnId]: 'turn-1',
      [FactoryUsageCorrelationHeaders.messageId]: 'message-runtime',
      [FactoryUsageCorrelationHeaders.executionId]: 'execution-1',
      [FactoryUsageCorrelationHeaders.frameId]: 'frame-1',
    });
    expect(secondOptions.headers).toMatchObject({
      [FactoryUsageCorrelationHeaders.sessionId]: 'session-runtime',
      [FactoryUsageCorrelationHeaders.turnId]: 'turn-2',
      [FactoryUsageCorrelationHeaders.messageId]: 'message-runtime-2',
      [FactoryUsageCorrelationHeaders.executionId]: 'execution-1',
      [FactoryUsageCorrelationHeaders.frameId]: 'frame-1',
    });
    const firstLlmCallId = firstOptions.headers[FactoryUsageCorrelationHeaders.llmCallId];
    const secondLlmCallId = secondOptions.headers[FactoryUsageCorrelationHeaders.llmCallId];
    expect(firstLlmCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondLlmCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(firstLlmCallId).not.toBe(secondLlmCallId);
    expect(usages).toEqual([
      expect.objectContaining({ llmCallId: firstLlmCallId, executionId: 'execution-1', frameId: 'frame-1' }),
      expect.objectContaining({ llmCallId: secondLlmCallId, executionId: 'execution-1', frameId: 'frame-1' }),
    ]);
  });

  it('does not send internal identifiers without explicit Factory Gateway opt-in', async () => {
    const bus = await AnthropicSdkConnectorNamespace.scopedBus();
    const create = vi.fn(async (_body: unknown, _options?: unknown) => messageStream());
    const session = new ExposedAnthropicSession({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'anthropic-sdk',
      agentId: 'agent-1',
      sessionId: 'session-runtime',
      cwd: '/tmp',
      model: 'claude-test',
      env: {},
      client: { messages: { create } } as unknown as Anthropic,
      anthropicTools: [],
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }),
    });
    const handle = new MessageHandle(
      'message-1',
      { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      'enqueue',
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      { executionId: 'execution-private', frameId: 'frame-private' },
    );

    await session.invokeProvider(handle);

    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('headers');
  });
});
