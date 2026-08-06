import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue, type MessageResult } from '@makaio/ai-adapters-core';
import type { SDKMessage } from '@makaio/client-claude-code';

const transportStub = vi.hoisted(() => {
  // The real transport settles its exit observation from the child's `exit`
  // event, which follows the kill `close()` sends. Mirroring that here is what
  // lets a session teardown reach its `exited` class instead of waiting out the
  // observation budget.
  let settleExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settleExit = resolve;
  });
  return {
    transport: {
      onMessage: vi.fn(),
      onError: vi.fn(),
      close: vi.fn(() => settleExit(null)),
      exited,
    },
  };
});

vi.mock('../utils/createStdioTransport.js', () => ({
  createStdioTransport: vi.fn(() => transportStub.transport),
}));

import { ClaudeCliSession } from '../session.js';
import { ClaudeCodeCliConnectorNamespace } from '../namespace/index.js';
import { makeTransportHarness } from './fixtures/transport-harness.js';

const transportHarness = makeTransportHarness(transportStub.transport);

function makeHandle(): MessageHandle {
  return new MessageHandle(
    'message-structured-output',
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'Return JSON' }],
      message: 'Return JSON',
    },
    'enqueue',
  );
}

function structuredOutputResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    structured_output: { ok: true },
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0.42,
    usage: {
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
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-1',
    session_id: 'session-1',
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolveDeferred: (() => void) | undefined;
  const promise = new Promise<void>((promiseResolve) => {
    resolveDeferred = promiseResolve;
  });
  return {
    promise,
    resolve(): void {
      if (!resolveDeferred) {
        throw new Error('Deferred resolver was not initialized');
      }
      resolveDeferred();
    },
  };
}

async function makeActiveSession() {
  const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();
  const handle = makeHandle();
  const emitSdkEvent = vi.fn(async () => undefined);
  const onTurnComplete = vi.fn();
  const session = new ClaudeCliSession({
    bus,
    adapterId: 'adapter-test',
    adapterName: 'claude-code-cli',
    agentId: 'agent-test',
    cwd: os.tmpdir(),
    model: 'claude-sonnet',
    env: {},
    emitSdkEvent,
    onTurnComplete,
  });
  const queue = new UserMessageQueue();
  queue.enqueue(handle);
  await session.processQueue(queue);
  return { emitSdkEvent, handle, onTurnComplete, session };
}

describe('ClaudeCliSession result message handling', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.reset();
  });

  it('serializes native structured_output into the terminal message', async () => {
    const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();
    const handle = makeHandle();
    const onTurnComplete = vi.fn();
    const session = new ClaudeCliSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      onTurnComplete,
    });

    try {
      const queue = new UserMessageQueue();
      queue.enqueue(handle);

      await expect(session.processQueue(queue)).resolves.toBe(true);
      expect(transportHarness.transport.onMessage).toHaveBeenCalledTimes(1);
      expect(transportHarness.transport.onError).toHaveBeenCalledTimes(1);

      transportHarness.emitMessage(structuredOutputResult());

      const expectedResult: MessageResult = {
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      };
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual(expectedResult);
      expect(onTurnComplete).toHaveBeenCalledWith(handle, expectedResult);
    } finally {
      await session.close();
    }
  });

  it('ignores late transport errors once result completion has started', async () => {
    const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();
    const turnFinishedPayloads: unknown[] = [];
    const unsubscribeTurnFinished = bus.on(ClaudeCodeCliConnectorNamespace.subjects.turn.turn_finished, (payload) => {
      turnFinishedPayloads.push(payload);
    });
    const handle = makeHandle();
    const onTurnCompleteGate = createDeferred();
    const onTurnComplete = vi.fn(async () => {
      await onTurnCompleteGate.promise;
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const session = new ClaudeCliSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      onTurnComplete,
    });

    try {
      const queue = new UserMessageQueue();
      queue.enqueue(handle);

      await expect(session.processQueue(queue)).resolves.toBe(true);

      transportHarness.emitMessage(structuredOutputResult());
      await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
        outcome: 'completed',
        result: { message: '{"ok":true}' },
      });

      transportHarness.emitError(new Error('late transport close'));
      onTurnCompleteGate.resolve();

      await vi.waitFor(() => {
        expect(turnFinishedPayloads).toHaveLength(1);
      });
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(consoleWarn).not.toHaveBeenCalledWith(
        expect.stringContaining('markCompleted called for messageId: message-structured-output but already completed.'),
      );
    } finally {
      consoleWarn.mockRestore();
      unsubscribeTurnFinished();
      await session.close();
    }
  });

  it('processes a terminal usage result that arrives during the close grace period', async () => {
    const { emitSdkEvent, handle, onTurnComplete, session } = await makeActiveSession();

    const closePromise = session.close();
    expect(transportHarness.transport.close).not.toHaveBeenCalled();

    const terminalResult = structuredOutputResult();
    transportHarness.emitMessage(terminalResult);

    await closePromise;
    await expect(handle.waitForCompletion(1_000)).resolves.toEqual({
      outcome: 'completed',
      result: { message: '{"ok":true}' },
    });
    expect(emitSdkEvent).toHaveBeenCalledWith(terminalResult);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
    expect(transportHarness.transport.close).toHaveBeenCalledTimes(1);
  });

  it('force-closes after the abort grace period when no terminal result arrives', async () => {
    vi.useFakeTimers();
    try {
      const { handle, onTurnComplete, session } = await makeActiveSession();

      const abortPromise = session.abort();
      expect(transportHarness.transport.close).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      await abortPromise;

      expect(transportHarness.transport.close).toHaveBeenCalledTimes(1);
      const result = await handle.waitForCompletion(1_000);
      expect(result.outcome).toBe('error');
      expect(result.error).toEqual(
        expect.objectContaining({ message: 'Claude Code CLI closed before emitting a terminal result' }),
      );
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('processes duplicate terminal results only once during graceful close', async () => {
    const { emitSdkEvent, onTurnComplete, session } = await makeActiveSession();
    const closePromise = session.close();
    const terminalResult = structuredOutputResult();

    transportHarness.emitMessage(terminalResult);
    transportHarness.emitMessage(terminalResult);

    await closePromise;
    expect(emitSdkEvent).toHaveBeenCalledTimes(1);
    expect(onTurnComplete).toHaveBeenCalledTimes(1);
  });

  it('ignores terminal results delivered after the close timeout', async () => {
    vi.useFakeTimers();
    try {
      const { emitSdkEvent, handle, onTurnComplete, session } = await makeActiveSession();
      const closePromise = session.close();

      await vi.advanceTimersByTimeAsync(250);
      await closePromise;
      transportHarness.emitMessage(structuredOutputResult());
      await Promise.resolve();

      expect(emitSdkEvent).not.toHaveBeenCalled();
      expect(onTurnComplete).toHaveBeenCalledTimes(1);
      expect(handle.isProcessed).toBe(true);
      const result = await handle.waitForCompletion(1_000);
      expect(result.outcome).toBe('error');
      expect(result.error).toEqual(
        expect.objectContaining({ message: 'Claude Code CLI closed before emitting a terminal result' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
