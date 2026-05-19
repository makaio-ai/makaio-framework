/// <reference types="bun-types" />
import os from 'node:os';
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { waitFor } from '@makaio/test-utils';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue, type MessageResult } from '@makaio/ai-adapters-core';

// ---------------------------------------------------------------------------
// SDK mock — controlled query factory, must be declared before import of session
// ---------------------------------------------------------------------------

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
const query = mock(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { sessionId: string } }) => ({
  interrupt: mock(async () => undefined),
  close: mock(() => undefined),
  setMcpServers: mock(async () => ({ added: [], removed: [], errors: {} })),
  setMaxThinkingTokens: mock(async () => undefined),
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

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query,
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
    query.mockClear();
  });

  it('invokes onTurnComplete from the real result-handling path', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const onTurnComplete = mock<(handle: MessageHandle, result: MessageResult) => void>();
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      onTurnComplete,
      emitSdkEvent: mock(async () => undefined),
    });

    try {
      await session.initialize(() => mock(async () => ({ behavior: 'allow' as const })));

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
    const emitSdkEvent = mock(async () => undefined);
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
      await session.initialize(() => mock(async () => ({ behavior: 'allow' as const })));

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
      emitSdkEvent: mock(async () => undefined),
    });

    try {
      await session.initialize(() => mock(async () => ({ behavior: 'allow' as const })));
      const oldQueryResult = query.mock.results[0]?.value as { close: ReturnType<typeof mock> } | undefined;
      expect(oldQueryResult).toBeDefined();

      const currentHandle = createMessageHandle('message-current');
      const immediateHandle = createMessageHandle('message-immediate', 'immediate');
      const queue = new UserMessageQueue();
      queue.enqueue(immediateHandle);

      let activeHandle = currentHandle;
      const currentTurn = {
        canAcceptImmediate: () => true,
        isCompleted: () => false,
        getMessageHandle: () => activeHandle,
        pause: mock(async () => ({ stateBeforePause: 'step_finished' as const, turnEnded: false })),
        isPaused: () => true,
        setActiveMessageHandle: mock((handle: MessageHandle) => {
          activeHandle = handle;
        }),
        resume: mock(async () => undefined),
        isExpectingInterruptResult: () => false,
        markCompleted: mock((result: MessageResult) => {
          activeHandle.markCompleted(result);
        }),
        handleSdkEvent: mock(async () => undefined),
      };
      setCurrentTurnForTest(session, currentTurn);

      await session.processQueue(queue);

      expect(currentTurn.pause).toHaveBeenCalledTimes(1);
      expect(currentTurn.setActiveMessageHandle).toHaveBeenCalledWith(immediateHandle);
      expect(currentTurn.resume).toHaveBeenCalledTimes(1);
      expect(oldQueryResult?.close).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(1);
      await expect(immediateHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });
    } finally {
      await session.close();
    }
  });

  it('does not await async onTurnComplete hooks before completing the handle', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let releaseHook: (() => void) | undefined;
    let hookSettled = false;
    const onTurnComplete = mock(async (_handle: MessageHandle, _result: MessageResult) => {
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
      emitSdkEvent: mock(async () => undefined),
    });

    try {
      await session.initialize(() => mock(async () => ({ behavior: 'allow' as const })));

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
      await waitFor(() => {
        expect(hookSettled).toBe(true);
      });
    } finally {
      releaseHook?.();
      await session.close();
    }
  });

  it('logs rejected onTurnComplete hooks without failing handle completion', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);
    const onTurnComplete = mock(async () => {
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
      emitSdkEvent: mock(async () => undefined),
    });

    try {
      await session.initialize(() => mock(async () => ({ behavior: 'allow' as const })));

      const queue = new UserMessageQueue();
      const handle = createMessageHandle('message-hook-rejection');
      queue.enqueue(handle);

      await session.processQueue(queue);

      const expectedCompletion: MessageResult = {
        outcome: 'completed',
        result: { message: 'session completed' },
      };
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual(expectedCompletion);
      await waitFor(() => {
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
