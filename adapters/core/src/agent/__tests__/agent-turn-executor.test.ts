import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { runPostUserMessageHooks, runPreUserMessageHooks } from '@makaio/hooks';
import { AgentTurnExecutor } from '../agent-turn-executor.js';
import type { AIAgentConnector } from '../../connector/index.js';
import type { SendMessageRequestPayload } from '../types.js';
import { MessageHandle } from '../../message-handle/index.js';
import { createDeferred, createMessageHandle, createExecutorConfig } from './agent-turn-executor-fixtures.js';

vi.mock('@makaio/hooks', () => ({
  runPreUserMessageHooks: vi.fn(
    async (_call: CallContext, payload: { message: unknown; sessionContext?: unknown }) => ({
      message: payload.message,
      sessionContext: payload.sessionContext,
    }),
  ),
  runPostUserMessageHooks: vi.fn(async () => {}),
}));

describe('AgentTurnExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards responseSchema in executeSendMessage connector options', async () => {
    const call = createTestCall();
    const sendMessage = vi.fn(async () => createMessageHandle(call, 'm-1', 'hello'));
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      ...createExecutorConfig(connector),
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
    await executor.executeSendMessage(call, payload);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        call,
        responseSchema: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
          name: 'ok_schema',
        },
      }),
    );
  });

  it.each([
    { decision: false, description: 'forwards useNativeResume: false so connectors suppress native resume' },
    { decision: true, description: 'forwards useNativeResume: true so connectors keep default resume behavior' },
  ])('$description', async ({ decision }) => {
    const call = createTestCall();
    const sendMessage = vi.fn(async () => createMessageHandle(call, 'm-resume', 'hello'));
    const start = vi.fn(async () => ({
      adapterSessionId: 'adapter-session-1',
      agentId: 'agent-1',
      messageHandle: createMessageHandle(call, 'm-resume-start', 'hello'),
    }));
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
      start: start as AIAgentConnector['start'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      globalBus: {} as IMakaioBus,
      getConnector: () => connector as AIAgentConnector,
      shouldUseNativeResume: () => decision,
      hasResumeTarget: () => false,
      setPendingStartMode: vi.fn(),
      onMessageHandle: async () => {},
    });

    await executor.executeSendMessage(call, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'hello',
      messageId: 'm-resume',
    });
    expect(sendMessage).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ useNativeResume: decision }));

    await executor.executeStart(call, 'hello', { messageId: 'm-resume-start' }, undefined);
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ useNativeResume: decision }));
  });

  it('injects structuredOutput turnContext when adapter lacks native capability', async () => {
    const call = createTestCall();
    const sendMessage = vi.fn(async () => createMessageHandle(call, 'm-inject', 'hello'));
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: [],
      ...createExecutorConfig(connector),
      onMessageHandle: async () => {},
    });

    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    await executor.executeSendMessage(call, {
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
    const call = createTestCall();
    const sendMessage = vi.fn(async () => createMessageHandle(call, 'm-native', 'hello'));
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterCapabilities: ['structuredOutput'],
      ...createExecutorConfig(connector),
      onMessageHandle: async () => {},
    });

    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    await executor.executeSendMessage(call, {
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
    const call = createTestCall();
    const sendMessage = vi.fn(async () => createMessageHandle(call, 'message-explicit', 'hello'));
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-ephemeral',
      adapterId: 'adapter-ephemeral',
      ...createExecutorConfig(connector),
      onMessageHandle: async () => {},
      ephemeral: true,
    });

    await executor.executeSendMessage(call, {
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

  it('keeps request correlation separate from prompt context and binds runtime IDs', async () => {
    const call = createTestCall();
    const sendMessage = vi.fn(async () => createMessageHandle(call, 'message-runtime', 'hello'));
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: sendMessage as AIAgentConnector['sendMessage'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      sessionId: 'session-runtime',
      ...createExecutorConfig(connector),
      onMessageHandle: async () => {},
    });

    await executor.executeSendMessage(call, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'hello',
      messageId: 'message-runtime',
      turnId: 'turn-runtime',
      sessionContext: {
        turnContext: { promptVisible: 'yes' },
        requestCorrelation: {
          sessionId: 'stale-session',
          turnId: 'stale-turn',
          messageId: 'stale-message',
          executionId: 'execution-1',
          frameId: 'frame-1',
        },
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        turnContext: { promptVisible: 'yes' },
        requestCorrelation: {
          sessionId: 'session-runtime',
          turnId: 'turn-runtime',
          messageId: 'message-runtime',
          executionId: 'execution-1',
          frameId: 'frame-1',
        },
      }),
    );
  });

  it('passes each request turnId to onMessageHandle when connector dispatch overlaps', async () => {
    const call = createTestCall();
    const firstHandle = createMessageHandle(call, 'request-1', 'first');
    const secondHandle = createMessageHandle(call, 'request-2', 'second');
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
      ...createExecutorConfig(connector),
      onMessageHandle: async (handle, turnId) => {
        handled.push({ messageId: handle.messageId, turnId });
      },
    });

    const first = executor.executeSendMessage(call, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'first',
      messageId: 'request-1',
      turnId: 'turn-1',
    });
    const second = executor.executeSendMessage(call, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'second',
      messageId: 'request-2',
      turnId: 'turn-2',
    });

    await expect(second).resolves.toEqual({ messageId: 'request-2' });
    firstDispatch.resolve(firstHandle);
    await expect(first).resolves.toEqual({ messageId: 'request-1' });

    expect(handled).toEqual([
      { messageId: 'request-2', turnId: 'turn-2' },
      { messageId: 'request-1', turnId: 'turn-1' },
    ]);
  });

  it('rejects a send connector that replaces an explicit canonical messageId before lifecycle tracking', async () => {
    const call = createTestCall();
    const onMessageHandle = vi.fn();
    const handleError = vi.fn();
    const mismatchedHandle = new MessageHandle(call, 'connector-generated', { role: 'user', blocks: [] }, 'enqueue');
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      sendMessage: vi.fn(async () => mismatchedHandle) as AIAgentConnector['sendMessage'],
      handleError,
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      ...createExecutorConfig(connector),
      onMessageHandle,
    });

    await expect(
      executor.executeSendMessage(call, {
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        message: 'hello',
        messageId: 'canonical-message',
      }),
    ).rejects.toThrow(
      'Adapter connector contract violation (adapter-1, sendMessage): expected MessageHandle.messageId "canonical-message", received "connector-generated"',
    );
    const completion = await mismatchedHandle.waitForCompletion();
    expect(completion).toMatchObject({ outcome: 'error' });
    expect(handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('contract violation') }),
      true,
    );
    expect(completion.error).toBe(handleError.mock.calls[0]?.[0]);
    expect(runPostUserMessageHooks).not.toHaveBeenCalled();
    expect(onMessageHandle).not.toHaveBeenCalled();
  });

  it('forwards and enforces an explicit canonical messageId on connector start', async () => {
    const call = createTestCall();
    const onMessageHandle = vi.fn();
    const handleError = vi.fn();
    const mismatchedHandle = new MessageHandle(call, 'connector-generated', { role: 'user', blocks: [] }, 'enqueue');
    const start = vi.fn(async () => ({
      adapterSessionId: 'adapter-session-1',
      agentId: 'agent-1',
      messageHandle: mismatchedHandle,
    }));
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      start: start as AIAgentConnector['start'],
      handleError,
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      ...createExecutorConfig(connector),
      onMessageHandle,
    });

    await expect(executor.executeStart(call, 'hello', { messageId: 'canonical-start' }, undefined)).rejects.toThrow(
      'Adapter connector contract violation (adapter-1, start): expected MessageHandle.messageId "canonical-start", received "connector-generated"',
    );
    const completion = await mismatchedHandle.waitForCompletion();
    expect(completion).toMatchObject({ outcome: 'error' });
    expect(handleError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('contract violation') }),
      true,
    );
    expect(completion.error).toBe(handleError.mock.calls[0]?.[0]);
    expect(runPostUserMessageHooks).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messageId: 'canonical-start' }));
    expect(onMessageHandle).not.toHaveBeenCalled();
  });

  it('allows a connector-generated messageId when start has no canonical identity', async () => {
    const call = createTestCall();
    const handle = new MessageHandle(call, 'connector-generated', { role: 'user', blocks: [] }, 'enqueue');
    const onMessageHandle = vi.fn(async () => {});
    const connector: Partial<AIAgentConnector> = {
      cwd: '/tmp',
      start: vi.fn(async () => ({
        adapterSessionId: 'adapter-session-1',
        agentId: 'agent-1',
        messageHandle: handle,
      })) as AIAgentConnector['start'],
    };
    const executor = new AgentTurnExecutor({
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      ...createExecutorConfig(connector),
      onMessageHandle,
    });

    await expect(executor.executeStart(call, 'hello', undefined, undefined)).resolves.toMatchObject({
      messageHandle: handle,
    });
    expect(onMessageHandle).toHaveBeenCalledWith(handle, undefined);
  });
});
