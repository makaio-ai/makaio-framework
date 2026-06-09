import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/index.js';
import { MessageHandle, type MessageResult } from '@makaio/ai-adapters-core';
import { OpenAIConnectorSession } from '../session.js';
import type { OpenAISessionConfig } from '../types/index.js';
import type { OpenAIConnectorTurn } from '../turn.js';
import { STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME } from '../structured-output-finalizer.js';
import {
  OpenAINodeConnectorNamespace,
  OpenAINodeConnectorSubjects,
  type OpenAINodeConnectorBus,
} from '../namespaces/index.js';

function createOpenAITool(name: string): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name,
      description: `Description for ${name}`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

/** Thin subclass that exposes the protected `getEffectiveToolNames` for assertions. */
class TestOpenAIConnectorSession extends OpenAIConnectorSession {
  public apiCallFn: (adapterSessionId: string) => Promise<void> = async () => {};
  public lastRequestTools: ChatCompletionTool[] = [];
  public lastRequestResponseSchema: MessageHandle['responseSchema'] = undefined;

  public constructor(config: OpenAISessionConfig) {
    super(config);
  }

  public override getEffectiveToolNames(): string[] {
    return super.getEffectiveToolNames();
  }

  public getHistory(): ChatCompletionMessageParam[] {
    return this.messages;
  }

  public appendHistoryForTest(...messages: ChatCompletionMessageParam[]): void {
    this.getHistory().push(...messages);
  }

  public startNewTurnForTest(handle: MessageHandle): Promise<void> {
    return this.startNewTurn(handle);
  }

  protected override async executeApiCall(
    _turn: OpenAIConnectorTurn,
    _abortSignal: AbortSignal,
    adapterSessionId: string,
  ): Promise<void> {
    this.lastRequestTools = this.buildRequestTools();
    this.lastRequestResponseSchema = this.getRequestResponseSchema();
    await this.apiCallFn(adapterSessionId);
  }
}

function createHandle(responseSchema?: MessageHandle['responseSchema']): MessageHandle {
  return new MessageHandle(
    'message-1',
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'Return JSON' }],
      message: 'Return JSON',
    },
    'enqueue',
    undefined,
    undefined,
    responseSchema,
  );
}

function getToolName(tool: ChatCompletionTool): string {
  return tool.type === 'function' ? tool.function.name : tool.custom.name;
}

function createSession(
  bus: OpenAINodeConnectorBus = {} as OpenAINodeConnectorBus,
  overrides: Partial<OpenAISessionConfig> = {},
): TestOpenAIConnectorSession {
  return new TestOpenAIConnectorSession({
    bus,
    adapterId: 'adapter-id',
    adapterName: 'openai-node',
    agentId: 'agent-id',
    cwd: '/tmp',
    model: 'gpt-4.1',
    env: {},
    client: {} as never,
    openAITools: [createOpenAITool('native_before')],
    emitSdkEvent: async () => {},
    handleError: () => {},
    requestToolApproval: async () => ({ action: 'allow' }),
    ...overrides,
  });
}

describe('OpenAIConnectorSession tool refresh', () => {
  it('rebuilds the live tool set from the latest native tools after refresh', () => {
    const session = createSession();

    session.replaceNativeTools([createOpenAITool('native_after')]);
    session.updateTools([
      {
        name: 'github__create_issue',
        description: 'Create issue',
        toolsetName: 'github',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);

    expect(session.getEffectiveToolNames()).toEqual(['native_after', 'github__create_issue']);
  });

  it('compacts provisional retry history when completion returns corrected structured output', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus);
    const handle = createHandle();
    handle.addCompletionTransform(
      (result): MessageResult => ({
        ...result,
        result: { message: '{"ok":true}' },
        structuredOutputValidation: { status: 'enforced' },
      }),
    );

    handle.addCompletionTransform((result): MessageResult => {
      session.appendHistoryForTest(
        { role: 'user', content: 'Previous output was invalid. Respond with corrected JSON.' },
        { role: 'assistant', content: '{"ok":true}' },
      );
      return result;
    });

    session.apiCallFn = async (adapterSessionId) => {
      await bus.emit(OpenAINodeConnectorSubjects.sdk.event, {
        event: {
          eventType: 'message_complete',
          content: 'not json',
          finish_reason: 'stop',
        },
        agentId: 'agent-id',
        adapterId: 'adapter-id',
        adapterName: 'openai-node',
        adapterSessionId,
      });
    };

    await session.startNewTurnForTest(handle);
    await handle.waitForCompletion();

    expect(session.getHistory()).toEqual([
      { role: 'user', content: 'Return JSON' },
      { role: 'assistant', content: '{"ok":true}' },
    ]);
  });

  it('keeps direct response_format routing when structured output has no tools', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const responseSchema = {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      name: 'ok_schema',
      strict: true,
    } satisfies NonNullable<MessageHandle['responseSchema']>;
    const session = createSession(bus, { openAITools: [] });
    const handle = createHandle(responseSchema);

    session.apiCallFn = async (adapterSessionId) => {
      await bus.emit(OpenAINodeConnectorSubjects.sdk.event, {
        event: {
          eventType: 'message_complete',
          content: '{"ok":true}',
          finish_reason: 'stop',
        },
        agentId: 'agent-id',
        adapterId: 'adapter-id',
        adapterName: 'openai-node',
        adapterSessionId,
      });
    };

    await session.startNewTurnForTest(handle);
    await expect(handle.waitForCompletion()).resolves.toEqual({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
    });

    expect(session.lastRequestTools).toEqual([]);
    expect(session.lastRequestResponseSchema).toBe(responseSchema);
    expect(session.getHistory()).toEqual([
      { role: 'user', content: 'Return JSON' },
      { role: 'assistant', content: '{"ok":true}' },
    ]);
  });

  it('uses the internal finalizer tool instead of response_format when structured output and tools are both active', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const approval = vi.fn(async () => ({ action: 'allow' as const }));
    const session = createSession(bus, { requestToolApproval: approval });
    const handle = createHandle({
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      name: 'ok_schema',
      strict: true,
    });

    session.apiCallFn = async (adapterSessionId) => {
      await bus.emit(OpenAINodeConnectorSubjects.sdk.event, {
        event: {
          eventType: 'message_complete',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [
            {
              id: 'call-final',
              type: 'function',
              function: {
                name: STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME,
                arguments: '{"ok":true}',
              },
            },
          ],
        },
        agentId: 'agent-id',
        adapterId: 'adapter-id',
        adapterName: 'openai-node',
        adapterSessionId,
      });
    };

    await session.startNewTurnForTest(handle);
    await expect(handle.waitForCompletion()).resolves.toEqual({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
    });

    expect(session.lastRequestResponseSchema).toBeUndefined();
    expect(session.lastRequestTools.map(getToolName)).toEqual(['native_before', STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME]);
    expect(session.getHistory()).toEqual([
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining(STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME),
      }),
      { role: 'assistant', content: '{"ok":true}' },
    ]);
    expect(approval).not.toHaveBeenCalled();
  });

  it('rejects registry tools that collide with the reserved structured-output finalizer name', async () => {
    const bus = await OpenAINodeConnectorNamespace.scopedBus();
    const session = createSession(bus, { openAITools: [createOpenAITool(STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME)] });
    const handle = createHandle({
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
      name: 'ok_schema',
    });

    session.apiCallFn = async () => {};

    await session.startNewTurnForTest(handle);
    await expect(handle.waitForCompletion()).resolves.toMatchObject({
      outcome: 'error',
      error: expect.objectContaining({
        message: `Tool name ${STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME} is reserved for structured output.`,
      }),
    });
  });
});
