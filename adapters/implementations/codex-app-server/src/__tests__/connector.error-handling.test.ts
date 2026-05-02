/**
 * Tests for CodexAppServerConnector - Error Handling
 *
 * Tests error handling scenarios:
 * - Client close on abort
 * - Client close on close
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createConnectorTestContext, cleanupConnectorTestContext, type ConnectorTestContext } from './shared.js';

describe('CodexAppServerConnector - Error handling', () => {
  let ctx: ConnectorTestContext;

  beforeEach(async () => {
    ctx = await createConnectorTestContext();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanupConnectorTestContext(ctx);
  });

  it('should close JSON-RPC client on abort', () => {
    expect(ctx.mockJsonRpcClient.closed).toBe(false);
    ctx.connector.abort();
    expect(ctx.mockJsonRpcClient.closed).toBe(true);
  });

  it('should close JSON-RPC client on close', async () => {
    expect(ctx.mockJsonRpcClient.closed).toBe(false);
    await ctx.connector.close();
    expect(ctx.mockJsonRpcClient.closed).toBe(true);
  });
});
