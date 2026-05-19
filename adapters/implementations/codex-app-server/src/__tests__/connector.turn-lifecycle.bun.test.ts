/// <reference types="bun-types" />
/**
 * Tests for CodexAppServerConnector - Turn Lifecycle
 *
 * Tests turn lifecycle events:
 * - Turn start/completion
 * - Message deltas
 * - Token usage updates
 * - Processing state transitions
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { CodexAppServerNamespace } from '../namespaces/index.js';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithTurn,
  createMockTurn,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Turn lifecycle', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    mock.clearAllMocks();
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
