import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue, type MessageResult } from '@makaio/ai-adapters-core';

const queryHarness = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    reset: () => {
      query.mockReset();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query: queryHarness.query,
}));

import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeConnectorSession } from '../src/session.js';
import {
  installDefaultQueryImpl,
  makeInitMessage,
  makeResultMessage,
  createMessageHandle,
} from './fixtures/query-harness.js';

describe('ClaudeConnectorSession iterator error query disowning', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
    installDefaultQueryImpl(queryHarness.query, { includeRateLimitEvent: true });
  });

  it('disowns the dead query after an iterator-level error so the next message gets a fresh query', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

    // First query: iterator throws after yielding system.init (confirms session ID)
    // so the session can resume on the next query.
    let messageReceived: () => void;
    const messageReceivedPromise = new Promise<void>((resolve) => {
      messageReceived = resolve;
    });
    queryHarness.query.mockImplementationOnce(
      ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { sessionId?: string } }) => {
        const effectiveSessionId = options.sessionId ?? crypto.randomUUID();
        return {
          interrupt: vi.fn(async () => undefined),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              yield makeInitMessage(effectiveSessionId);
              messageReceived!();
              // Simulate an iterator-level SDK/transport error
              throw new Error('SDK transport failure');
            }
          },
        } as unknown as ReturnType<typeof queryHarness.query>;
      },
    );

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));
      expect(queryHarness.query).toHaveBeenCalledTimes(1);

      // Send first message — will trigger the iterator error
      const queue = new UserMessageQueue();
      const handle1 = createMessageHandle('message-error-turn');
      queue.enqueue(handle1);
      await session.processQueue(queue);

      // Wait for the iterator error to propagate through handleConsumptionError
      await messageReceivedPromise;
      // Allow microtasks from the consumption loop's catch to settle
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // First handle should have been completed with error
      const result1 = await handle1.waitForCompletion(2_000);
      expect(result1.outcome).toBe('error');
      expect((result1 as { error: Error }).error.message).toBe('SDK transport failure');

      // Verify the dead query was disowned: queryInstance and source should be undefined
      expect(session.getQueryInstance()).toBeUndefined();

      // Now send a second message — this should create a fresh query, not reuse the dead one
      const queue2 = new UserMessageQueue();
      const handle2 = createMessageHandle('message-after-error');
      queue2.enqueue(handle2);
      await session.processQueue(queue2);

      // The default query mock (non-throwing) is restored, so this should work
      expect(queryHarness.query).toHaveBeenCalledTimes(2);

      const result2 = await handle2.waitForCompletion(2_000);
      expect(result2.outcome).toBe('completed');
      expect((result2 as { result: { message: string } }).result.message).toBe('session completed');
    } finally {
      consoleError.mockRestore();
      await session.close();
    }
  });

  it('clears queryInstance before turn_finished so connector queue processing cannot reuse dead query', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

    let messageReceived: () => void;
    const messageReceivedPromise = new Promise<void>((resolve) => {
      messageReceived = resolve;
    });
    queryHarness.query.mockImplementationOnce(
      ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { sessionId?: string } }) => {
        const effectiveSessionId = options.sessionId ?? crypto.randomUUID();
        return {
          interrupt: vi.fn(async () => undefined),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              yield makeInitMessage(effectiveSessionId);
              messageReceived!();
              throw new Error('iterator crash');
            }
          },
        } as unknown as ReturnType<typeof queryHarness.query>;
      },
    );

    // Install a stub turn so we can observe finishOnError timing
    let queryInstanceAtFinishOnError: unknown = 'not-called';
    const handle = createMessageHandle('message-timing');
    let completed = false;
    const currentTurn = {
      canAcceptImmediate: () => false,
      isCompleted: () => completed,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => {
        completed = true;
        handle.markCompleted(result);
      }),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => {
        // Capture queryInstance at the moment finishOnError is called.
        // It should already be undefined (disowned before this call).
        queryInstanceAtFinishOnError = session.getQueryInstance();
      }),
      isPaused: () => false,
    };

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      // Inject the stub turn
      Reflect.set(session, 'currentTurn', currentTurn);

      // Push a message to trigger the iterator error
      const source = Reflect.get(session, 'source') as { push: (msg: unknown) => void };
      source.push({ role: 'user', content: 'trigger' });

      await messageReceivedPromise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // finishOnError should have been called
      expect(currentTurn.finishOnError).toHaveBeenCalledTimes(1);
      // queryInstance must have been cleared BEFORE finishOnError was called
      expect(queryInstanceAtFinishOnError).toBeUndefined();
    } finally {
      consoleError.mockRestore();
      await session.close();
    }
  });

  it('disowns the dead query even when the turn is already completed, so the next message gets a fresh query', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

    // Iterator yields a result (completing the turn), then throws.
    let messageReceived: () => void;
    const messageReceivedPromise = new Promise<void>((resolve) => {
      messageReceived = resolve;
    });
    queryHarness.query.mockImplementationOnce(
      ({ prompt, options }: { prompt: AsyncIterable<unknown>; options: { sessionId?: string } }) => {
        const effectiveSessionId = options.sessionId ?? crypto.randomUUID();
        return {
          interrupt: vi.fn(async () => undefined),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            for await (const _message of prompt) {
              yield makeInitMessage(effectiveSessionId);
              // Yield a successful result — this completes the turn
              yield makeResultMessage(effectiveSessionId, { result: 'turn completed' });
              messageReceived!();
              // Iterator crashes after the result was already delivered
              throw new Error('post-result transport failure');
            }
          },
        } as unknown as ReturnType<typeof queryHarness.query>;
      },
    );

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));
      expect(queryHarness.query).toHaveBeenCalledTimes(1);

      // Send first message — turn will complete successfully, then iterator throws
      const queue = new UserMessageQueue();
      const handle1 = createMessageHandle('message-completed-then-error');
      queue.enqueue(handle1);
      await session.processQueue(queue);

      await messageReceivedPromise;
      // Let the consumption error propagate
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));

      // First handle completed successfully with the real result
      const result1 = await handle1.waitForCompletion(2_000);
      expect(result1.outcome).toBe('completed');
      expect((result1 as { result: { message: string } }).result.message).toBe('turn completed');

      // The dead query must be disowned even though the turn was completed
      expect(session.getQueryInstance()).toBeUndefined();

      // Send a second message — must create a fresh query, not hang on dead source
      const queue2 = new UserMessageQueue();
      const handle2 = createMessageHandle('message-after-completed-error');
      queue2.enqueue(handle2);
      await session.processQueue(queue2);

      expect(queryHarness.query).toHaveBeenCalledTimes(2);
      const result2 = await handle2.waitForCompletion(2_000);
      expect(result2.outcome).toBe('completed');
      expect((result2 as { result: { message: string } }).result.message).toBe('session completed');
    } finally {
      consoleError.mockRestore();
      await session.close();
    }
  });
});
