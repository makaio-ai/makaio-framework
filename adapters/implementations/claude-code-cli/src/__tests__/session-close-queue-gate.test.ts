import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import type { SDKMessage } from '@makaio/client-claude-code';

const transportStub = vi.hoisted(() => ({
  transport: {
    onMessage: vi.fn(),
    onError: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('../utils/createStdioTransport.js', () => ({
  createStdioTransport: vi.fn(() => transportStub.transport),
}));

import { ClaudeCliSession } from '../session.js';
import { ClaudeCodeCliConnectorNamespace } from '../namespace/index.js';
import { makeTransportHarness } from './fixtures/transport-harness.js';

const transportHarness = makeTransportHarness(transportStub.transport);

function makeHandle(messageId = 'message-1'): MessageHandle {
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

function successResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
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

describe('ClaudeCliSession shutdown vs queue processing', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.reset();
  });

  it('completes dequeued handle when close() begins during startTurn setup', async () => {
    const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();

    // Simulate close() interleaving during the awaited MCP registration
    // by spying on registerMcpContextAndBuildConfig and setting closing = true
    // before returning, mimicking a concurrent close() call during the await.
    let callCount = 0;
    const onTurnStart = vi.fn();
    const session = new ClaudeCliSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
      onTurnStart,
    });
    // Intercept the async MCP registration to simulate close() racing mid-await.
    const originalRegister = Reflect.get(session, 'registerMcpContextAndBuildConfig').bind(session);
    Reflect.set(session, 'registerMcpContextAndBuildConfig', async (...args: unknown[]) => {
      callCount++;
      // On the second call (the racing turn), simulate close() interleaving
      // by setting this.closing = true during the awaited MCP registration.
      if (callCount >= 2) {
        Reflect.set(session, 'closing', true);
      }
      return originalRegister(...args);
    });

    // Start and complete a first turn so the session has a confirmed state
    const firstQueue = new UserMessageQueue();
    const firstHandle = makeHandle('message-first');
    firstQueue.enqueue(firstHandle);
    await session.processQueue(firstQueue);
    transportHarness.emitMessage(successResult());
    await expect(firstHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });

    const { createStdioTransport } = await import('../utils/createStdioTransport.js');
    const initialTransportCount = vi.mocked(createStdioTransport).mock.calls.length;

    // onTurnStart should have been called once for the successful first turn
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(onTurnStart).toHaveBeenCalledWith(firstHandle);

    // Reset transport harness for the second turn
    transportHarness.reset();

    // Enqueue a racing handle — when processQueue calls startTurn, the
    // resolveTurnExecutionContext mock will set closing = true mid-await.
    const queue = new UserMessageQueue();
    const racingHandle = makeHandle('message-racing');
    queue.enqueue(racingHandle);

    const turnStarted = await session.processQueue(queue);
    // processQueue must return false: startTurn was entered but the shutdown
    // gate completed the handle without spawning a subprocess. Returning true
    // would leave the connector in processing state with no turn_finished event
    // to transition it back to idle, causing complete() to hang.
    expect(turnStarted).toBe(false);

    // The racing handle must complete with an error, not hang
    const result = await racingHandle.waitForCompletion(1_000);
    expect(result.outcome).toBe('error');
    expect((result as { error: Error }).error.message).toContain('Session closed');

    // No new transport should have been spawned for the racing turn
    expect(vi.mocked(createStdioTransport).mock.calls.length).toBe(initialTransportCount);

    // onTurnStart must NOT have been called for the skipped handle — if it
    // fires before the closing recheck, the connector's pendingMessageHandle
    // is set for a handle that already completed, and onTurnComplete never
    // clears it. This leaves stale connector state that blocks complete()
    // and future sends.
    expect(onTurnStart).toHaveBeenCalledTimes(1);
    expect(onTurnStart).not.toHaveBeenCalledWith(racingHandle);
  });

  it('rejects queued handles after close() begins instead of starting a new subprocess', async () => {
    const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();
    const session = new ClaudeCliSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
    });

    // Start and complete a first turn
    const firstQueue = new UserMessageQueue();
    const firstHandle = makeHandle('message-first');
    firstQueue.enqueue(firstHandle);
    await session.processQueue(firstQueue);
    transportHarness.emitMessage(successResult());
    await expect(firstHandle.waitForCompletion(1_000)).resolves.toMatchObject({ outcome: 'completed' });

    // Record how many transports were created
    const { createStdioTransport } = await import('../utils/createStdioTransport.js');
    const initialTransportCount = vi.mocked(createStdioTransport).mock.calls.length;

    // Close the session — sets the closing flag
    transportHarness.reset();
    await session.close();

    // Now try to process a queued message — it should be rejected, not spawn a new process
    const queue = new UserMessageQueue();
    const queuedHandle = makeHandle('message-queued-after-close');
    queue.enqueue(queuedHandle);

    const turnStarted = await session.processQueue(queue);
    expect(turnStarted).toBe(false);

    // The queued handle must complete with an error, not hang
    const result = await queuedHandle.waitForCompletion(1_000);
    expect(result.outcome).toBe('error');

    // No new transport should have been created
    expect(vi.mocked(createStdioTransport).mock.calls.length).toBe(initialTransportCount);
  });

  it('rejects queued follow-ups during close() drain window', async () => {
    const bus = await ClaudeCodeCliConnectorNamespace.scopedBus();
    const session = new ClaudeCliSession({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'claude-code-cli',
      agentId: 'agent-test',
      cwd: os.tmpdir(),
      model: 'claude-sonnet',
      env: {},
      emitSdkEvent: vi.fn(async () => undefined),
    });

    // Start a turn (transport is active)
    const firstQueue = new UserMessageQueue();
    const activeHandle = makeHandle('message-active');
    firstQueue.enqueue(activeHandle);
    await session.processQueue(firstQueue);

    // Enqueue a follow-up while the first turn is still active
    const followUpQueue = new UserMessageQueue();
    const followUpHandle = makeHandle('message-follow-up');
    followUpQueue.enqueue(followUpHandle);

    // Close the session while the first turn is still active
    // The drain window opens; emit a result during it
    const closePromise = session.close();
    transportHarness.emitMessage(successResult());
    await closePromise;

    // processQueue should reject the follow-up
    const turnStarted = await session.processQueue(followUpQueue);
    expect(turnStarted).toBe(false);

    const result = await followUpHandle.waitForCompletion(1_000);
    expect(result.outcome).toBe('error');
    expect((result as { error: Error }).error.message).toContain('Session closed');
  });
});
