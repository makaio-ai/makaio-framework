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
});
