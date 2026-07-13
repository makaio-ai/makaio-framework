/**
 * Tests for CodexAppServerConnector - Complete
 *
 * Tests complete functionality:
 * - Waiting for idle state before completing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithThread,
  createMockTurn,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Complete', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('should wait for idle state before completing', async () => {
    await startConnectorWithThread(ctx, 'Test');

    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    // Start complete() call (should wait)
    const completePromise = ctx.connector.complete();

    // Turn completes after delay
    setTimeout(() => {
      ctx.mockJsonRpcClient
        .receiveNotification('turn/completed', {
          threadId: 'thread-123',
          turn: { id: 'turn-456', status: 'completed' },
        })
        .catch((err: unknown) => {
          console.error('Test notification failed:', err);
        });
    }, 10);

    await expect(completePromise).resolves.toBeDefined();
  });

  it('uses the authoritative completed agent message when structured output has no deltas', async () => {
    await startConnectorWithThread(ctx, 'Return structured output');
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await ctx.mockJsonRpcClient.receiveNotification('item/completed', {
      threadId: 'thread-123',
      turnId: 'turn-456',
      item: { type: 'agentMessage', id: 'message-1', text: '{"status":"ok"}' },
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: { id: 'turn-456', status: 'completed' },
    });

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: '{"status":"ok"}' },
    });
  });

  it('uses the agent message carried by turn completion when no item notification arrived', async () => {
    await startConnectorWithThread(ctx, 'Return structured output');
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: {
        id: 'turn-456',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'message-1', text: '{"status":"ok"}' }],
      },
    });

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'completed',
      result: { message: '{"status":"ok"}' },
    });
  });

  it('propagates failed turn completion instead of synthesizing an empty successful response', async () => {
    await startConnectorWithThread(ctx, 'Return structured output');
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: {
        id: 'turn-456',
        status: 'failed',
        items: [],
        error: { message: 'schema rejected', codexErrorInfo: null, additionalDetails: null },
      },
    });

    await expect(ctx.connector.complete()).resolves.toMatchObject({
      outcome: 'error',
      error: expect.objectContaining({ message: 'schema rejected' }),
    });
  });
});
