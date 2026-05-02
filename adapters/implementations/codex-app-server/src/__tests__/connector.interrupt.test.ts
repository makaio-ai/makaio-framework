/**
 * Tests for CodexAppServerConnector - Interrupt
 *
 * Tests interrupt functionality:
 * - Sending turn/interrupt request
 * - Handling interrupt when no turn is active
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createConnectorTestContext,
  cleanupConnectorTestContext,
  startConnectorWithTurn,
  createMockTurn,
  type ConnectorTestContext,
} from './shared.js';

describe('CodexAppServerConnector - Interrupt', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
    await startConnectorWithTurn(ctx);
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('should send turn/interrupt request on interrupt', async () => {
    await ctx.connector.interrupt();

    const interruptRequest = ctx.mockJsonRpcClient.sentRequests.find((r) => r.method === 'turn/interrupt');
    expect(interruptRequest).toBeDefined();
    expect(interruptRequest?.params).toMatchObject({
      turnId: 'turn-456',
    });
  });

  it('should handle interrupt gracefully when no turn is active', async () => {
    // Complete the turn first
    await ctx.mockJsonRpcClient.receiveNotification('turn/completed', {
      threadId: 'thread-123',
      turn: createMockTurn({ id: 'turn-456', status: 'completed' }),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Should not throw
    await expect(ctx.connector.interrupt()).resolves.toBeUndefined();
  });
});
