import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue, type MessageResult } from '@makaio/ai-adapters-core';

const queryHarness = vi.hoisted(() => {
  const query = vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { sessionId: string } }) => ({
    interrupt: vi.fn(async () => undefined),
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      for await (const _message of prompt) {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: options.sessionId,
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: options.sessionId,
          result: 'session completed',
        };
        return;
      }
    },
  }));

  return {
    query,
    reset: () => {
      query.mockClear();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query: queryHarness.query,
}));

import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeConnectorSession } from '../src/session.js';

function createMessageHandle(messageId = 'message-1'): MessageHandle {
  return new MessageHandle(
    messageId,
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'hello' }],
      message: 'hello',
    },
    'enqueue',
  );
}

describe('ClaudeConnectorSession onTurnComplete seam', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
  });

  it('invokes onTurnComplete from the real result-handling path', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const onTurnComplete = vi.fn<(handle: MessageHandle, result: MessageResult) => void>();
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      onTurnComplete,
      emitSdkEvent: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      const queue = new UserMessageQueue();
      const handle = createMessageHandle();
      queue.enqueue(handle);

      await session.processQueue(queue);

      const completion = await handle.waitForCompletion(1_000);
      expect(completion).toEqual<MessageResult>({
        outcome: 'completed',
        result: { message: 'session completed' },
      });
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(onTurnComplete).toHaveBeenCalledWith(handle, completion);
    } finally {
      await session.close();
    }
  });

  it('does not await async onTurnComplete hooks before completing the handle', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let releaseHook: (() => void) | undefined;
    let hookSettled = false;
    const onTurnComplete = vi.fn(async (_handle: MessageHandle, _result: MessageResult) => {
      await new Promise<void>((resolve) => {
        releaseHook = resolve;
      });
      hookSettled = true;
    });
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      onTurnComplete,
      emitSdkEvent: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      const queue = new UserMessageQueue();
      const handle = createMessageHandle('message-async-hook');
      queue.enqueue(handle);

      await session.processQueue(queue);

      const expectedCompletion: MessageResult = {
        outcome: 'completed',
        result: { message: 'session completed' },
      };
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual(expectedCompletion);
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(hookSettled).toBe(false);

      releaseHook?.();
      await vi.waitFor(() => {
        expect(hookSettled).toBe(true);
      });
    } finally {
      releaseHook?.();
      await session.close();
    }
  });

  it('logs rejected onTurnComplete hooks without failing handle completion', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onTurnComplete = vi.fn(async () => {
      throw new Error('hook failed');
    });
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      onTurnComplete,
      emitSdkEvent: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      const queue = new UserMessageQueue();
      const handle = createMessageHandle('message-hook-rejection');
      queue.enqueue(handle);

      await session.processQueue(queue);

      const expectedCompletion: MessageResult = {
        outcome: 'completed',
        result: { message: 'session completed' },
      };
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual(expectedCompletion);
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          'Session: onTurnComplete hook failed:',
          expect.objectContaining({
            sessionId: expect.any(String),
            messageId: handle.messageId,
            error: expect.any(Error),
          }),
        );
      });
    } finally {
      consoleError.mockRestore();
      await session.close();
    }
  });
});
