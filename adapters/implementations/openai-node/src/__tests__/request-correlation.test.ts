import { afterEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/index.js';
import { FactoryUsageCorrelationHeaders, MessageHandle } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { OpenAIConnectorSession } from '../session.js';
import type { OpenAISessionConfig } from '../types/index.js';
import type { OpenAIConnectorTurn } from '../turn.js';
import { OpenAINodeConnectorNamespace, OpenAINodeConnectorSubjects, type UsageEvent } from '../namespaces/index.js';

class ExposedOpenAISession extends OpenAIConnectorSession {
  public async invokeProvider(handle: MessageHandle): Promise<void> {
    const turn = {
      getMessageHandle: () => handle,
      markStepStarted: async () => {},
      markStepFinished: async () => {},
    } as OpenAIConnectorTurn;
    await super.executeApiCall(turn, new AbortController().signal, 'adapter-session-1');
  }
}

async function* completionStream(): AsyncGenerator<ChatCompletionChunk> {
  yield {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-test',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('OpenAI Factory Gateway request correlation', () => {
  it('sends the allowlisted headers and emits the same per-request LLM call ID on usage', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const create = vi.fn(async (_body: unknown, _options?: unknown) => completionStream());
    const usages: UsageEvent[] = [];
    bus.on(OpenAINodeConnectorSubjects.sdk.event, ({ payload }) => {
      if (payload.event.eventType === 'usage') usages.push(payload.event);
    });
    const config: OpenAISessionConfig = {
      bus,
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      agentId: 'agent-1',
      sessionId: 'session-runtime',
      cwd: '/tmp',
      model: 'gpt-test',
      env: {},
      client: { chat: { completions: { create } } } as unknown as OpenAI,
      openAITools: [],
      requestCorrelationHeaders: 'factory-v1',
      supportsResponseFormatWithTools: true,
      supportsStructuredOutputStrict: true,
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }),
    };
    const session = new ExposedOpenAISession(config);
    const handle = new MessageHandle(
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

    await session.invokeProvider(handle);

    const options = create.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(options.headers).toMatchObject({
      [FactoryUsageCorrelationHeaders.sessionId]: 'session-runtime',
      [FactoryUsageCorrelationHeaders.turnId]: 'turn-1',
      [FactoryUsageCorrelationHeaders.messageId]: 'message-runtime',
      [FactoryUsageCorrelationHeaders.executionId]: 'execution-1',
      [FactoryUsageCorrelationHeaders.frameId]: 'frame-1',
    });
    const llmCallId = options.headers[FactoryUsageCorrelationHeaders.llmCallId];
    expect(llmCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(usages).toEqual([expect.objectContaining({ llmCallId, executionId: 'execution-1', frameId: 'frame-1' })]);
  });

  it('does not send internal identifiers without explicit Factory Gateway opt-in', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const create = vi.fn(async (_body: unknown, _options?: unknown) => completionStream());
    const session = new ExposedOpenAISession({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      agentId: 'agent-1',
      cwd: '/tmp',
      model: 'gpt-test',
      env: {},
      client: { chat: { completions: { create } } } as unknown as OpenAI,
      openAITools: [],
      supportsResponseFormatWithTools: true,
      supportsStructuredOutputStrict: true,
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }),
    });
    const handle = new MessageHandle(
      'message-1',
      { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      'enqueue',
    );

    await session.invokeProvider(handle);

    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('headers');
  });
});
