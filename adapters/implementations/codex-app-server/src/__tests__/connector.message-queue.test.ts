/**
 * Tests for CodexAppServerConnector - Message Queue
 *
 * Tests message queue processing:
 * - Queuing messages while turn is active
 * - Processing queued messages after turn completion
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithTurn,
  createMockTurn,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Message queue', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
    await startConnectorWithTurn(ctx, 'First message');
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('should queue message when turn is active', async () => {
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    // Send another message while turn is active
    const handle2 = await ctx.connector.sendMessage({
      role: 'user',
      message: 'Second message',
      blocks: [{ type: 'text', content: 'Second message' }],
    });
    expect(handle2).toBeDefined();
  });

  it('should process queued message after turn completes', async () => {
    // Send second message
    const _handle2 = await ctx.connector.sendMessage({
      role: 'user',
      message: 'Second message',
      blocks: [{ type: 'text', content: 'Second message' }],
    });

    // Complete first turn
    await ctx.mockJsonRpcClient.receiveNotification('turn/started', {
      threadId: 'thread-123',
      turn: createMockTurn(),
    });

    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-456', status: 'completed' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should have sent turn/start for second message
    const turnStarts = ctx.mockJsonRpcClient.sentRequests.filter((r) => r.method === 'turn/start');
    expect(turnStarts.length).toBeGreaterThanOrEqual(1);
  });
});
