/**
 * End-to-end WebSocket transport reconnection tests using real ws library.
 *
 * These tests verify connection loss and auto-reconnect behavior
 * without using mocks. Each test creates real WebSocket connections and
 * validates reconnect behavior via `WebSocketClientTransport`'s built-in
 * exponential-backoff reconnect loop.
 */

import { describe, it } from 'vitest';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createTestServer, waitForCondition } from './test-utils.js';

// ============================================================================
// CONNECTION LOSS AND RECONNECT E2E
// ============================================================================

describe('Connection loss and reconnect E2E', () => {
  it('fires onDisconnected and reconnects when server closes connection', async () => {
    const { wss: wss1, port: port1 } = await createTestServer();

    let disconnectCount = 0;

    const transport = new WebSocketClientTransport({
      url: `ws://localhost:${port1}`,
      autoReconnect: { baseMs: 100, maxMs: 500 },
      onDisconnected: () => {
        disconnectCount++;
      },
    });

    try {
      await transport.connect();

      // Force the server to close all connections
      for (const client of wss1.clients) {
        client.close();
      }

      await waitForCondition(() => disconnectCount > 0, 3000, 'onDisconnected was not fired');
      await waitForCondition(() => transport.isReady(), 3000, 'transport did not reconnect');
    } finally {
      await transport.disconnect();
      await new Promise<void>((resolve) => wss1.close(() => resolve()));
    }
  }, 10000);
});
