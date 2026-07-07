import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import { runPreUserMessageHooks } from '@makaio/hooks';
import { AgentTurnExecutor } from '../agent-turn-executor.js';
import type { AIAgentConnector } from '../../connector/index.js';
import type { SendMessageRequestPayload } from '../types.js';
import { MessageHandle } from '../../message-handle/index.js';

vi.mock('@makaio/hooks', () => ({
  runPreUserMessageHooks: vi.fn(async (payload: { message: unknown; sessionContext?: unknown }) => ({
    message: payload.message,
    sessionContext: payload.sessionContext,
  })),
  runPostUserMessageHooks: vi.fn(async () => {}),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

describe('AgentTurnExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards responseSchema in executeSendMessage connector options', async () => {
    const sendMessage = vi.fn(
      async () =>
        new MessageHandle(
          'm-1',
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'hello' }],
          },
          'enqueue',
        ),
    );
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      globalBus: {} as IMakaioBus,
      getConnector: () => connector as AIAgentConnector,
      shouldUseNativeResume: () => false,
      hasResumeTarget: () => false,
      setPendingStartMode: vi.fn(),
      onMessageHandle: async () => {},
    });

    const payload: SendMessageRequestPayload = {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'hello',
      responseSchema: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        name: 'ok_schema',
      },
    };
    await executor.executeSendMessage(payload);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        responseSchema: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          name: 'ok_schema',
        },
      }),
    );
  });

  it('injects structuredOutput turnContext when adapter lacks native capability', async () => {
    const sendMessage = vi.fn(
      async () =>
        new MessageHandle(
          'm-inject',
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'hello' }],
          },
          'enqueue',
        ),
    );
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
      globalBus: {} as IMakaioBus,
      getConnector: () => connector as AIAgentConnector,
      shouldUseNativeResume: () => false,
      hasResumeTarget: () => false,
      setPendingStartMode: vi.fn(),
      onMessageHandle: async () => {},
    });

    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    await executor.executeSendMessage({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'hello',
      responseSchema: { schema, name: 'ok_schema' },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turnContext: expect.objectContaining({
          structuredOutput: expect.stringContaining('Respond ONLY with valid JSON'),
        }),
      }),
    );
  });

  it('does not inject structuredOutput turnContext when adapter has native capability', async () => {
    const sendMessage = vi.fn(
      async () =>
        new MessageHandle(
          'm-native',
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'hello' }],
          },
          'enqueue',
        ),
    );
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: ['structuredOutput'],
      globalBus: {} as IMakaioBus,
      getConnector: () => connector as AIAgentConnector,
      shouldUseNativeResume: () => false,
      hasResumeTarget: () => false,
      setPendingStartMode: vi.fn(),
      onMessageHandle: async () => {},
    });

    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    await executor.executeSendMessage({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'hello',
      responseSchema: { schema, name: 'ok_schema' },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ turnContext: expect.anything() }),
    );
  });

  it('skips PreUserMessage hooks for ephemeral executeSendMessage turns', async () => {
    const sendMessage = vi.fn(
      async () =>
        new MessageHandle(
          'm-ephemeral',
          {
            role: 'user',
            blocks: [{ type: 'text', content: 'hello' }],
          },
          'enqueue',
        ),
    );
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-ephemeral',
      adapterId: 'adapter-ephemeral',
      globalBus: {} as IMakaioBus,
      getConnector: () => connector as AIAgentConnector,
      shouldUseNativeResume: () => false,
      hasResumeTarget: () => false,
      setPendingStartMode: vi.fn(),
      onMessageHandle: async () => {},
      ephemeral: true,
    });

    await executor.executeSendMessage({
      agentId: 'agent-ephemeral',
      adapterId: 'adapter-ephemeral',
      message: 'hello',
      messageId: 'message-explicit',
    });

    expect(runPreUserMessageHooks).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'hello',
      }),
      expect.objectContaining({
        messageId: 'message-explicit',
      }),
    );
  });

  it('passes each request turnId to onMessageHandle when connector dispatch overlaps', async () => {
    const firstHandle = new MessageHandle(
      'm-overlap-1',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'first' }],
      },
      'enqueue',
    );
    const secondHandle = new MessageHandle(
      'm-overlap-2',
      {
        role: 'user',
        blocks: [{ type: 'text', content: 'second' }],
      },
      'enqueue',
    );
    const firstDispatch = createDeferred<MessageHandle>();
    const sendMessage = vi.fn(async (_message, options: { messageId?: string }) => {
      if (options.messageId === 'request-1') {
        return firstDispatch.promise;
      }
      return secondHandle;
    });
    const handled: Array<{ messageId: string; turnId: string | undefined }> = [];
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      globalBus: {} as IMakaioBus,
      getConnector: () => connector as AIAgentConnector,
      shouldUseNativeResume: () => false,
      hasResumeTarget: () => false,
      setPendingStartMode: vi.fn(),
      onMessageHandle: async (handle, turnId) => {
        handled.push({ messageId: handle.messageId, turnId });
      },
    });

    const first = executor.executeSendMessage({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'first',
      messageId: 'request-1',
      turnId: 'turn-1',
    });
    const second = executor.executeSendMessage({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'second',
      messageId: 'request-2',
      turnId: 'turn-2',
    });

    await expect(second).resolves.toEqual({ messageId: 'm-overlap-2' });
    firstDispatch.resolve(firstHandle);
    await expect(first).resolves.toEqual({ messageId: 'm-overlap-1' });

    expect(handled).toEqual([
      { messageId: 'm-overlap-2', turnId: 'turn-2' },
      { messageId: 'm-overlap-1', turnId: 'turn-1' },
    ]);
  });
});
