/// <reference types="bun-types" />
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IMakaioBus } from '@makaio/bus-core';
import { runPreUserMessageHooks } from '@makaio/hooks';
import { AgentTurnExecutor } from '../agent-turn-executor.js';
import type { AIAgentConnector } from '../../connector/index.js';
import type { SendMessageRequestPayload } from '../types.js';
import { MessageHandle } from '../../message-handle/index.js';

mock.module('@makaio/hooks', () => ({
  runPreUserMessageHooks: mock(async (payload: { message: unknown; sessionContext?: unknown }) => ({
    message: payload.message,
    sessionContext: payload.sessionContext,
  })),
  runPostUserMessageHooks: mock(async () => {}),
}));

describe('AgentTurnExecutor', () => {
  beforeEach(() => {
    mock.clearAllMocks();
  });

  it('forwards responseSchema in executeSendMessage connector options', async () => {
    const sendMessage = mock(
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
      onMessageHandle: async () => {},
    });

    const payload: SendMessageRequestPayload = {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      message: 'hello',
      responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    };
    await executor.executeSendMessage(payload);

    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      }),
    );
  });

  it('skips PreUserMessage hooks for ephemeral executeSendMessage turns', async () => {
    const sendMessage = mock(
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
});
