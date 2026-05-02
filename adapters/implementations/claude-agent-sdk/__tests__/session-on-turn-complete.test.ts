import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue, type MessageResult } from '@makaio/ai-adapters-core';

const queryHarness = vi.hoisted(() => {
  const sdkBase = (sessionId: string) => ({
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    agentId: 'agent-test',
  });
  const usage = {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0 },
    service_tier: 'standard',
  };
  const query = vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { sessionId: string } }) => ({
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
    setMaxThinkingTokens: vi.fn(async () => undefined),
    async *[Symbol.asyncIterator]() {
      for await (const _message of prompt) {
        yield {
          type: 'rate_limit_event',
          retry_after_ms: 1000,
          session_id: options.sessionId,
        };
        yield {
          ...sdkBase(options.sessionId),
          type: 'system',
          subtype: 'init',
          apiKeySource: 'user',
          cwd: os.tmpdir(),
          tools: [],
          mcp_servers: [],
          model: 'claude-sonnet-4-20250514',
          permissionMode: 'default',
          slash_commands: [],
          output_style: 'default',
        };
        yield {
          ...sdkBase(options.sessionId),
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'session completed',
          duration_ms: 1,
          duration_api_ms: 1,
          num_turns: 1,
          total_cost_usd: 0,
          usage,
          modelUsage: {},
          permission_denials: [],
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

/**
 * Install a current-turn seam for tests that exercise queue interleavings.
 * @param session - Session under test.
 * @param currentTurn - Stub turn implementation.
 */
function setCurrentTurnForTest(session: ClaudeConnectorSession, currentTurn: unknown): void {
  expect(Reflect.set(session, 'currentTurn', currentTurn)).toBe(true);
}

function createMessageHandle(
  messageId = 'message-1',
  deliveryMode: 'enqueue' | 'replace' | 'immediate' = 'enqueue',
): MessageHandle {
  return new MessageHandle(
    messageId,
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'hello' }],
      message: 'hello',
    },
    deliveryMode,
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

  it('emits unknown SDK payloads before skipping turn-state handling', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const emitSdkEvent = vi.fn(async () => undefined);
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      emitSdkEvent,
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      const queue = new UserMessageQueue();
      const handle = createMessageHandle('message-unknown-sdk-event');
      queue.enqueue(handle);

      await session.processQueue(queue);
      await expect(handle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });
      expect(emitSdkEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'rate_limit_event',
          retry_after_ms: 1000,
        }),
      );
    } finally {
      await session.close();
    }
  });

  it('resumes the paused query when immediate mode replaces the active turn', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));
      const oldQuery = queryHarness.query.mock.results[0]?.value;
      expect(oldQuery).toBeDefined();

      const currentHandle = createMessageHandle('message-current');
      const immediateHandle = createMessageHandle('message-immediate', 'immediate');
      const queue = new UserMessageQueue();
      queue.enqueue(immediateHandle);

      let activeHandle = currentHandle;
      const currentTurn = {
        canAcceptImmediate: () => true,
        isCompleted: () => false,
        getMessageHandle: () => activeHandle,
        pause: vi.fn(async () => ({ stateBeforePause: 'step_finished' as const, turnEnded: false })),
        isPaused: () => true,
        setActiveMessageHandle: vi.fn((handle: MessageHandle) => {
          activeHandle = handle;
        }),
        resume: vi.fn(async () => undefined),
        isExpectingInterruptResult: () => false,
        markCompleted: vi.fn((result: MessageResult) => {
          activeHandle.markCompleted(result);
        }),
        handleSdkEvent: vi.fn(async () => undefined),
      };
      setCurrentTurnForTest(session, currentTurn);

      await session.processQueue(queue);

      expect(currentTurn.pause).toHaveBeenCalledTimes(1);
      expect(currentTurn.setActiveMessageHandle).toHaveBeenCalledWith(immediateHandle);
      expect(currentTurn.resume).toHaveBeenCalledTimes(1);
      expect(oldQuery.close).not.toHaveBeenCalled();
      expect(queryHarness.query).toHaveBeenCalledTimes(1);
      await expect(immediateHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });
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
