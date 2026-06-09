/**
 * Tests for CodexAppServerConnector - Turn Lifecycle
 *
 * Tests turn lifecycle events:
 * - Turn start/completion
 * - Message deltas
 * - Token usage updates
 * - Processing state transitions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CodexAppServerNamespace } from '../namespaces/index.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithTurn,
  startConnectorAndEmitThreadStarted,
  createMockTurn,
  createMockThread,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Turn lifecycle', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
    await startConnectorWithTurn(ctx);
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('should update processing state on turn/started', async () => {
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    // State transitions through processing_started -> turn_started quickly
    expect(ctx.connector.getProcessingState()).toBe('turn_started');
  });

  it('should emit agent_message_delta on item/agentMessage/delta', async () => {
    const emittedEvents: unknown[] = [];
    ctx.mockBus.on(CodexAppServerNamespace.subjects.agent_message_delta, (busCtx) => {
      emittedEvents.push(busCtx.payload);
    });

    // Must include threadId and turnId for event to be emitted
    await ctx.mockJsonRpcClient.receiveNotification('item/agentMessage/delta', {
      threadId: 'thread-123',
      turnId: 'turn-456',
      delta: 'Hello',
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({ delta: 'Hello' });
  });

  it('should emit token_usage on thread/tokenUsage/updated', async () => {
    const emittedEvents: unknown[] = [];
    ctx.mockBus.on(CodexAppServerNamespace.subjects.token_usage, (busCtx) => {
      emittedEvents.push(busCtx.payload);
    });

    await ctx.mockJsonRpcClient.receiveNotification('thread/tokenUsage/updated', {
      threadId: 'thread-123',
      tokenUsage: {
        last: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          cachedInputTokens: 0,
          reasoningOutputTokens: 20,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0]).toMatchObject({
      promptTokens: 100,
      inputCachedTokens: 0,
      completionTokens: 50,
      reasoningTokens: 20,
      totalTokens: 150,
    });
  });

  it('should mark message as completed on turn/completed', async () => {
    // First, complete the initial turn from beforeEach
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-456', status: 'completed' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Now send a new message - it should become the pending message
    const messageHandle = await ctx.connector.sendMessage({
      role: 'user',
      message: 'Another message',
      blocks: [{ type: 'text', content: 'Another message' }],
    });

    // Simulate turn lifecycle for the new message
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: { id: 'turn-789', status: 'inProgress' },
    });

    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-789', status: 'completed' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(messageHandle.state).toBe('completed');
  });

  it('should update processing state to idle after turn/completed when queue is empty', async () => {
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-456', status: 'completed' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.connector.getProcessingState()).toBe('idle');
  });
});

describe('CodexAppServerConnector - outputSchema forwarding', () => {
  it('includes outputSchema in turn/start when message handle has responseSchema', async () => {
    const localCtx = await createConnectorTestContext();

    try {
      const startPromise = localCtx.connector.start(
        {
          role: 'user',
          message: 'Hello',
          blocks: [{ type: 'text', content: 'Hello' }],
        },
        {
          responseSchema: { schema: { type: 'object' }, name: 'object_schema' },
        },
      );

      // Yield to allow startThread() to register the deferred promise.
      await new Promise((resolve) => setTimeout(resolve, 0));

      await localCtx.mockJsonRpcClient.receiveNotification('thread/started', {
        thread: createMockThread(),
      });

      await startPromise;

      const turnStartRequests = localCtx.mockJsonRpcClient.sentRequests.filter((r) => r.method === 'turn/start');
      expect(turnStartRequests).toHaveLength(1);
      expect((turnStartRequests[0].params as { outputSchema: unknown }).outputSchema).toEqual({ type: 'object' });
    } finally {
      cleanupConnectorTestContext(localCtx);
    }
  });

  it('sends outputSchema as null when message handle has no responseSchema', async () => {
    const localCtx = await createConnectorTestContext();

    try {
      await startConnectorAndEmitThreadStarted(localCtx.connector, localCtx.mockJsonRpcClient);

      const turnStartRequests = localCtx.mockJsonRpcClient.sentRequests.filter((r) => r.method === 'turn/start');
      expect(turnStartRequests).toHaveLength(1);
      expect((turnStartRequests[0].params as { outputSchema: unknown }).outputSchema).toBeNull();
    } finally {
      cleanupConnectorTestContext(localCtx);
    }
  });
});
