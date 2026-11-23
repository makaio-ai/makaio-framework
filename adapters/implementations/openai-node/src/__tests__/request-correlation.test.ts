import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import type { ChatCompletionChunk } from 'openai/resources/index.js';
import { FactoryUsageCorrelationHeaders, MessageHandle } from '@makaio/ai-adapters-core';
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import { OpenAIConnectorSession } from '../session.js';
import type { OpenAISessionConfig } from '../types/index.js';
import { OpenAINodeConnectorNamespace, OpenAINodeConnectorSubjects, type UsageEvent } from '../namespaces/index.js';

class ExposedOpenAISession extends OpenAIConnectorSession {
  public async invokeProvider(handle: MessageHandle): Promise<void> {
    const turn = this.createTurn(handle);
    await super.executeApiCall(turn, new AbortController().signal, 'adapter-session-1');
  }
}

function createClient(): OpenAI {
  const chunk: ChatCompletionChunk = {
    id: 'completion-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-test',
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  return new OpenAI({
    apiKey: 'test-key',
    fetch: async () => new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`),
  });
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

MakaioBus.registerNamespaces([OpenAINodeConnectorNamespace.definition]);

describe('OpenAI Factory Gateway request correlation', () => {
  it('sends the allowlisted headers and emits the same per-request LLM call ID on usage', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus(MakaioBus);
    const client = createClient();
    const create = vi.spyOn(client.chat.completions, 'create');
    const usages: UsageEvent[] = [];
    bus.on(OpenAINodeConnectorSubjects.sdk.event, ({ payload }) => {
      if (payload.event.eventType === 'usage') usages.push(payload.event);
    });
    const config: OpenAISessionConfig & { globalBus: IMakaioBus } = {
      bus,
      globalBus: MakaioBus,
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      agentId: 'agent-1',
      sessionId: 'session-runtime',
      cwd: '/tmp',
      model: 'gpt-test',
      env: {},
      client,
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
      createTestCall(),
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
    const bus = await OpenAINodeConnectorNamespace.scopedBus(MakaioBus);
    const client = createClient();
    const create = vi.spyOn(client.chat.completions, 'create');
    const session = new ExposedOpenAISession({
      bus,
      globalBus: MakaioBus,
      adapterId: 'adapter-1',
      adapterName: 'openai-node',
      agentId: 'agent-1',
      cwd: '/tmp',
      model: 'gpt-test',
      env: {},
      client,
      openAITools: [],
      supportsResponseFormatWithTools: true,
      supportsStructuredOutputStrict: true,
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }),
    });
    const handle = new MessageHandle(
      createTestCall(),
      'message-1',
      { role: 'user', message: 'hello', blocks: [{ type: 'text', content: 'hello' }] },
      'enqueue',
    );

    await session.invokeProvider(handle);

    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('headers');
  });
});
