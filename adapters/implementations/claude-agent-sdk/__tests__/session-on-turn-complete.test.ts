import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue, type MessageResult } from '@makaio/ai-adapters-core';
import type { SDKMessage } from '@makaio/client-claude-code';
import { McpSubjects } from '@makaio/contracts';

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
import { installDefaultQueryImpl, createMessageHandle } from './fixtures/query-harness.js';

/**
 * Install a current-turn seam for tests that exercise queue interleavings.
 * @param session - Session under test.
 * @param currentTurn - Stub turn implementation.
 */
function setCurrentTurnForTest(session: ClaudeConnectorSession, currentTurn: unknown): void {
  expect(Reflect.set(session, 'currentTurn', currentTurn)).toBe(true);
}

describe('ClaudeConnectorSession onTurnComplete seam', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
    installDefaultQueryImpl(queryHarness.query, {
      includeRateLimitEvent: true,
      includeOutputFormat: true,
    });
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

  it('uses initial responseSchema without rotating before the first turn', async () => {
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
    const responseSchema = {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      name: 'ok_schema',
    } satisfies NonNullable<MessageHandle['responseSchema']>;

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })), responseSchema);

      expect(queryHarness.query).toHaveBeenCalledTimes(1);
      expect(queryHarness.query.mock.calls[0]?.[0].options.outputFormat).toEqual({
        type: 'json_schema',
        schema: responseSchema.schema,
      });

      const queue = new UserMessageQueue();
      const handle = createMessageHandle('message-initial-structured-output', 'enqueue', responseSchema);
      queue.enqueue(handle);

      await session.processQueue(queue);

      expect(queryHarness.query).toHaveBeenCalledTimes(1);
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      });
    } finally {
      await session.close();
    }
  });

  it('rotates the SDK query with outputFormat and completes from structured_output', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const registeredMcpSessionIds: string[] = [];
    const unregisteredMcpSessionIds: string[] = [];
    MakaioBus.on(McpSubjects.session.register, (ctx) => {
      registeredMcpSessionIds.push(ctx.payload.adapterSessionId);
      ctx.setResult({ port: 12345 });
    });
    MakaioBus.on(McpSubjects.session.unregister, (ctx) => {
      unregisteredMcpSessionIds.push(ctx.payload.adapterSessionId);
    });
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

      const queue = new UserMessageQueue();
      const handle = createMessageHandle('message-structured-output', 'enqueue', {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        name: 'ok_schema',
      });
      queue.enqueue(handle);

      await session.processQueue(queue);

      expect(queryHarness.query).toHaveBeenCalledTimes(2);
      const firstStructuredOptions = queryHarness.query.mock.calls.at(-1)?.[0].options;
      if (!firstStructuredOptions) {
        throw new Error('Expected structured output query options');
      }
      expect(firstStructuredOptions.outputFormat).toEqual({
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      });
      expect(firstStructuredOptions).not.toHaveProperty('resume');
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      });
      expect(registeredMcpSessionIds).toHaveLength(2);
      expect(unregisteredMcpSessionIds).toEqual([registeredMcpSessionIds[0]]);

      const sameSchemaQueue = new UserMessageQueue();
      const sameSchemaHandle = createMessageHandle('message-structured-output-same-schema', 'enqueue', {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        name: 'renamed_ok_schema',
      });
      sameSchemaQueue.enqueue(sameSchemaHandle);

      await session.processQueue(sameSchemaQueue);

      expect(queryHarness.query).toHaveBeenCalledTimes(2);
      await expect(sameSchemaHandle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      });

      const nextQueue = new UserMessageQueue();
      const nextHandle = createMessageHandle('message-structured-output-next', 'enqueue', {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, label: { type: 'string' } },
          required: ['ok', 'label'],
        },
        name: 'labeled_ok_schema',
      });
      nextQueue.enqueue(nextHandle);

      await session.processQueue(nextQueue);

      expect(queryHarness.query).toHaveBeenCalledTimes(3);
      const secondStructuredOptions = queryHarness.query.mock.calls.at(-1)?.[0].options;
      if (!secondStructuredOptions) {
        throw new Error('Expected resumed structured output query options');
      }
      expect(secondStructuredOptions.resume).toBe(firstStructuredOptions.sessionId);
      expect(secondStructuredOptions.outputFormat).toEqual({
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, label: { type: 'string' } },
          required: ['ok', 'label'],
        },
      });
      await expect(nextHandle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      });
      expect(registeredMcpSessionIds).toHaveLength(3);
      expect(unregisteredMcpSessionIds).toEqual([registeredMcpSessionIds[0]]);
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
        finishOnError: vi.fn(async () => undefined),
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

  it('rotates the paused query when immediate mode introduces a response schema', async () => {
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
      const immediateHandle = createMessageHandle('message-immediate-structured-output', 'immediate', {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        name: 'ok_schema',
      });
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
        finishOnError: vi.fn(async () => undefined),
      };
      setCurrentTurnForTest(session, currentTurn);

      await session.processQueue(queue);

      expect(currentTurn.pause).toHaveBeenCalledTimes(1);
      expect(currentTurn.resume).not.toHaveBeenCalled();
      expect(currentTurn.setActiveMessageHandle).not.toHaveBeenCalled();
      expect(oldQuery.close).toHaveBeenCalledTimes(1);
      expect(queryHarness.query).toHaveBeenCalledTimes(2);
      expect(queryHarness.query.mock.calls.at(-1)?.[0].options.outputFormat).toEqual({
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
      });
      await expect(immediateHandle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      });
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
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
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
        expect(consoleWarn).toHaveBeenCalledWith(
          `[MessageHandle] completion notification failed for messageId: ${handle.messageId}`,
          expect.any(Error),
        );
      });
    } finally {
      consoleWarn.mockRestore();
      await session.close();
    }
  });

  it('emits and completes from a terminal result delivered during close interruption', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let resolveResult: (value: unknown) => void = () => undefined;
    const terminalResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
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

    queryHarness.query.mockImplementationOnce(
      () =>
        ({
          interrupt: vi.fn(async () => {
            resolveResult({
              type: 'result',
              session_id: session.getConfirmedSessionId(),
              subtype: 'success',
              is_error: false,
              result: 'interrupted result',
              total_cost_usd: 0.01,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            yield (await terminalResult) as SDKMessage;
          },
        }) as unknown as ReturnType<typeof queryHarness.query>,
    );

    const handle = createMessageHandle('message-close-result');
    setCurrentTurnForTest(session, {
      isCompleted: () => false,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => handle.markCompleted(result)),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => undefined),
    });

    await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));
    await session.close();

    await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
      outcome: 'completed',
      result: { message: 'interrupted result' },
    });
    expect(emitSdkEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 } }),
    );
  });

  it('does not wait indefinitely when interruption yields no terminal result', async () => {
    vi.useFakeTimers();
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    const query = {
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(() => undefined),
      setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => undefined);
      },
    };
    queryHarness.query.mockImplementationOnce(() => query as unknown as ReturnType<typeof queryHarness.query>);
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
    const handle = createMessageHandle('message-close-timeout');
    setCurrentTurnForTest(session, {
      isCompleted: () => false,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => handle.markCompleted(result)),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));
      const closePromise = session.close();
      await vi.advanceTimersByTimeAsync(250);
      await expect(closePromise).resolves.toBeUndefined();
      expect(query.close).toHaveBeenCalledTimes(1);
      await expect(handle.waitForCompletion(1_000)).resolves.toMatchObject({
        outcome: 'error',
        error: expect.objectContaining({ message: 'Claude query interrupted before terminal result' }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not emit a duplicate terminal result after the interruption drain has cleared', async () => {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let resolveFirstResult: (value: unknown) => void = () => undefined;
    let resolveDuplicateResult: (value: unknown) => void = () => undefined;
    const firstResult = new Promise<unknown>((resolve) => {
      resolveFirstResult = resolve;
    });
    const duplicateResult = new Promise<unknown>((resolve) => {
      resolveDuplicateResult = resolve;
    });
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
    const query = {
      interrupt: vi.fn(async () => {
        resolveFirstResult({
          type: 'result',
          session_id: session.getConfirmedSessionId(),
          subtype: 'success',
          is_error: false,
          result: 'first',
        });
      }),
      close: vi.fn(() => undefined),
      setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
      setMaxThinkingTokens: vi.fn(async () => undefined),
      async *[Symbol.asyncIterator]() {
        yield (await firstResult) as SDKMessage;
        yield (await duplicateResult) as SDKMessage;
      },
    };
    queryHarness.query.mockImplementationOnce(() => query as unknown as ReturnType<typeof queryHarness.query>);
    const handle = createMessageHandle('message-close-duplicate');
    let completed = false;
    setCurrentTurnForTest(session, {
      isCompleted: () => completed,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => {
        completed = true;
        handle.markCompleted(result);
      }),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => undefined),
    });

    await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));
    const queryGeneration = Reflect.get(session, 'queryGeneration') as number;
    const terminalResultDrain = Reflect.get(session, 'terminalResultDrain') as {
      waitForResult: (generation: number) => Promise<boolean>;
    };
    const drain = terminalResultDrain.waitForResult(queryGeneration);
    await query.interrupt();
    await drain;
    expect(Reflect.get(terminalResultDrain, 'active')).toBeUndefined();

    resolveDuplicateResult({
      type: 'result',
      session_id: session.getConfirmedSessionId(),
      subtype: 'success',
      is_error: false,
      result: 'duplicate',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(emitSdkEvent).toHaveBeenCalledTimes(1);
    await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
      outcome: 'completed',
      result: { message: 'first' },
    });
    await session.close();
  });

  it('rejects a late SDK result that arrives during error-completion after drain timeout', async () => {
    vi.useFakeTimers();
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let resolveResult: (value: unknown) => void = () => undefined;
    const terminalResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const emitSdkEvent = vi.fn(async (_msg: unknown) => undefined);

    // Make onTurnComplete async so the late result can arrive while
    // handleConsumptionError awaits markCompletedWithFinalResult.
    let releaseOnTurnComplete: (() => void) | undefined;
    const onTurnComplete = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          releaseOnTurnComplete = resolve;
        }),
    );
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      emitSdkEvent,
      onTurnComplete,
    });
    // Two-yield iterator: yields the late result after the drain times out,
    // then parks so the consumption loop stays alive during the test.
    const yieldedSecond = new Promise<void>((resolve) => {
      queryHarness.query.mockImplementationOnce(
        () =>
          ({
            interrupt: vi.fn(async () => undefined),
            close: vi.fn(() => undefined),
            setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
            setMaxThinkingTokens: vi.fn(async () => undefined),
            async *[Symbol.asyncIterator]() {
              // The late result delivered after the drain timeout fires.
              // Signal BEFORE the yield: the consumption loop exits on the
              // stale-generation check without pulling another value, so a
              // post-yield signal would never run.
              const lateResult = (await terminalResult) as SDKMessage;
              resolve();
              yield lateResult;
              // Park the iterator so the consumption loop does not exit
              await new Promise<void>(() => undefined);
            },
          }) as unknown as ReturnType<typeof queryHarness.query>,
      );
    });
    const handle = createMessageHandle('message-late-during-error-completion');
    let completed = false;
    setCurrentTurnForTest(session, {
      isCompleted: () => completed,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => {
        completed = true;
        handle.markCompleted(result);
      }),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      // Start close — interrupt is a no-op, drain starts
      const closePromise = session.close();

      // Advance past the 250 ms drain timeout so the error-completion path begins.
      // onTurnComplete is now blocking inside handleConsumptionError.
      await vi.advanceTimersByTimeAsync(250);

      // Deliver the late result while onTurnComplete is still in-flight
      resolveResult({
        type: 'result',
        session_id: session.getConfirmedSessionId(),
        subtype: 'success',
        is_error: false,
        result: 'late-during-error',
      });
      // Let the consumption loop process the yielded result
      await yieldedSecond;
      await vi.advanceTimersByTimeAsync(0);

      // Release onTurnComplete so close() can finish
      releaseOnTurnComplete?.();
      await vi.advanceTimersByTimeAsync(0);
      await closePromise;

      // The late result must NOT have been emitted — the drain was retired
      const resultEmissions = emitSdkEvent.mock.calls.filter(
        (call) => (call[0] as { type?: string }).type === 'result',
      );
      expect(resultEmissions).toHaveLength(0);

      // Handle must have completed with the timeout error, not the late result
      await expect(handle.waitForCompletion(1_000)).resolves.toMatchObject({
        outcome: 'error',
        error: expect.objectContaining({ message: 'Claude query interrupted before terminal result' }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not trigger the interruption error path when a terminal result is accepted but onTurnComplete exceeds 250ms', async () => {
    vi.useFakeTimers();
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let resolveResult: (value: unknown) => void = () => undefined;
    const terminalResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const emitSdkEvent = vi.fn(async (_msg: unknown) => undefined);

    // Slow onTurnComplete that takes >250ms — previously this would cause the
    // drain to time out and fire the interruption error path.
    let releaseHook: (() => void) | undefined;
    const onTurnComplete = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          releaseHook = resolve;
        }),
    );
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      emitSdkEvent,
      onTurnComplete,
    });

    queryHarness.query.mockImplementationOnce(
      () =>
        ({
          interrupt: vi.fn(async () => {
            // Deliver the result immediately on interrupt (within the 250ms window)
            resolveResult({
              type: 'result',
              session_id: session.getConfirmedSessionId(),
              subtype: 'success',
              is_error: false,
              result: 'graceful result',
              total_cost_usd: 0.01,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            yield (await terminalResult) as SDKMessage;
          },
        }) as unknown as ReturnType<typeof queryHarness.query>,
    );

    const handle = createMessageHandle('message-slow-hook-drain');
    setCurrentTurnForTest(session, {
      isCompleted: () => false,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => handle.markCompleted(result)),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      const closePromise = session.close();

      // Let the result be consumed by the consumption loop. The drain should
      // resolve immediately (markHandled fires before awaiting onTurnComplete).
      await vi.advanceTimersByTimeAsync(0);

      // Advance well past the 250ms drain timeout while onTurnComplete is still blocked.
      await vi.advanceTimersByTimeAsync(500);

      // Release the slow hook so close() can finish
      releaseHook?.();
      await vi.advanceTimersByTimeAsync(0);
      await closePromise;

      // The real result must have won — NOT the interruption error
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: 'graceful result' },
      });

      // The result must have been emitted
      const resultEmissions = emitSdkEvent.mock.calls.filter(
        (call) => (call[0] as { type?: string }).type === 'result',
      );
      expect(resultEmissions).toHaveLength(1);
    } finally {
      releaseHook?.();
      vi.useRealTimers();
    }
  });

  it('does not satisfy the drain when an absorbed interrupt result arrives during close', async () => {
    vi.useFakeTimers();
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let resolveInterruptResult: (value: unknown) => void = () => undefined;
    const interruptResult = new Promise<unknown>((resolve) => {
      resolveInterruptResult = resolve;
    });
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
    queryHarness.query.mockImplementationOnce(
      () =>
        ({
          interrupt: vi.fn(async () => {
            // Deliver the interrupt result during close's interrupt() call
            resolveInterruptResult({
              type: 'result',
              session_id: session.getConfirmedSessionId(),
              subtype: 'error',
              is_error: true,
              result: 'interrupted',
            });
          }),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            yield (await interruptResult) as SDKMessage;
            // Park the iterator so consumption stays alive
            await new Promise<void>(() => undefined);
          },
        }) as unknown as ReturnType<typeof queryHarness.query>,
    );

    const handle = createMessageHandle('message-absorbed-interrupt');
    // Simulate a turn that is expecting the interrupt result (immediate-message pause flow).
    // The turn absorbs the result without completing the active handle.
    let expectingInterrupt = true;
    setCurrentTurnForTest(session, {
      isCompleted: () => false,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => expectingInterrupt,
      markCompleted: vi.fn((result: MessageResult) => handle.markCompleted(result)),
      handleSdkEvent: vi.fn(async (msg: SDKMessage) => {
        // Mirror real turn behavior: absorb the result, clear the flag
        if (msg.type === 'result' && expectingInterrupt) {
          expectingInterrupt = false;
        }
      }),
      finishOnError: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      const closePromise = session.close();

      // Let the interrupt result be consumed
      await vi.advanceTimersByTimeAsync(0);

      // The drain must NOT have been satisfied by the absorbed interrupt result.
      // Advance past the 250 ms drain timeout — the timeout path must fire.
      await vi.advanceTimersByTimeAsync(250);
      await closePromise;

      // The handle must have been completed via completeInterruptedTurnAfterDrainTimeout,
      // NOT skipped because the drain was falsely satisfied.
      await expect(handle.waitForCompletion(1_000)).resolves.toMatchObject({
        outcome: 'error',
        error: expect.objectContaining({ message: 'Claude query interrupted before terminal result' }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still satisfies the drain immediately when a genuinely accepted result arrives during close', async () => {
    vi.useFakeTimers();
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let resolveResult: (value: unknown) => void = () => undefined;
    const terminalResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const emitSdkEvent = vi.fn(async () => undefined);

    // Slow onTurnComplete to verify the drain resolves BEFORE finalizers complete
    let releaseHook: (() => void) | undefined;
    const onTurnComplete = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          releaseHook = resolve;
        }),
    );
    const session = new ClaudeConnectorSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-agent-sdk',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet-4-20250514',
      env: {},
      emitSdkEvent,
      onTurnComplete,
    });

    queryHarness.query.mockImplementationOnce(
      () =>
        ({
          interrupt: vi.fn(async () => {
            resolveResult({
              type: 'result',
              session_id: session.getConfirmedSessionId(),
              subtype: 'success',
              is_error: false,
              result: 'accepted result',
              total_cost_usd: 0.01,
              usage: { input_tokens: 1, output_tokens: 1 },
            });
          }),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            yield (await terminalResult) as SDKMessage;
          },
        }) as unknown as ReturnType<typeof queryHarness.query>,
    );

    const handle = createMessageHandle('message-accepted-result-drain');
    setCurrentTurnForTest(session, {
      isCompleted: () => false,
      getMessageHandle: () => handle,
      // NOT expecting interrupt result — this is a genuinely accepted result
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => handle.markCompleted(result)),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));

      const closePromise = session.close();

      // Let the result be consumed — drain should resolve immediately
      await vi.advanceTimersByTimeAsync(0);

      // Advance well past 250 ms while onTurnComplete is blocked
      await vi.advanceTimersByTimeAsync(500);

      // Release the slow hook
      releaseHook?.();
      await vi.advanceTimersByTimeAsync(0);
      await closePromise;

      // The real result must have won — NOT the interruption error path
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: 'accepted result' },
      });
    } finally {
      releaseHook?.();
      vi.useRealTimers();
    }
  });

  it('omits a terminal result that arrives after the interruption drain times out', async () => {
    vi.useFakeTimers();
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    let resolveResult: (value: unknown) => void = () => undefined;
    const terminalResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
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
    queryHarness.query.mockImplementationOnce(
      () =>
        ({
          interrupt: vi.fn(async () => undefined),
          close: vi.fn(() => undefined),
          setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
          setMaxThinkingTokens: vi.fn(async () => undefined),
          async *[Symbol.asyncIterator]() {
            yield (await terminalResult) as SDKMessage;
          },
        }) as unknown as ReturnType<typeof queryHarness.query>,
    );
    const handle = createMessageHandle('message-close-late');
    setCurrentTurnForTest(session, {
      isCompleted: () => false,
      getMessageHandle: () => handle,
      isExpectingInterruptResult: () => false,
      markCompleted: vi.fn((result: MessageResult) => handle.markCompleted(result)),
      handleSdkEvent: vi.fn(async () => undefined),
      finishOnError: vi.fn(async () => undefined),
    });

    try {
      await session.initialize(() => vi.fn(async () => ({ behavior: 'allow' as const })));
      const closePromise = session.close();
      await vi.advanceTimersByTimeAsync(250);
      await closePromise;
      resolveResult({
        type: 'result',
        session_id: session.getConfirmedSessionId(),
        subtype: 'success',
        is_error: false,
        result: 'late',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(emitSdkEvent).not.toHaveBeenCalled();
      await expect(handle.waitForCompletion(1_000)).resolves.toMatchObject({
        outcome: 'error',
        error: expect.objectContaining({ message: 'Claude query interrupted before terminal result' }),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
