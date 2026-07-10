/**
 * Shared test utilities for WebSocket transport tests.
 */

import { WebSocketServer, type WebSocket } from 'ws';

/**
 * Create a WebSocket server on a random available port.
 * @param options - Extra `WebSocketServer` options (e.g. `{ autoPong: false }`)
 * @returns Promise containing the WebSocket server and bound port number
 */
export async function createTestServer(options?: { autoPong?: boolean }): Promise<{
  wss: WebSocketServer;
  port: number;
}> {
  const wss = new WebSocketServer({ port: 0, ...options });

  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', (err) => reject(err));
  });

  const address = wss.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    throw new Error('Failed to get server address');
  }

  return { wss, port: address.port };
}

/**
 * Close a WebSocket server, terminating any remaining clients first.
 * @param wss - Server to close
 */
export async function closeServer(wss: WebSocketServer): Promise<void> {
  for (const client of wss.clients) {
    client.terminate();
  }
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
}

/**
 * Helper to wait for a WebSocket to be in OPEN state.
 * @param ws - WebSocket to wait for
 */
export async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === 1) {
    return;
  }

  return new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
    };

    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

/**
 * Helper to wait for a specific number of messages with fail-fast timeout.
 *
 * This prevents tests from hanging until vitest timeout (5-10s) by failing
 * quickly with a clear error message when messages don't arrive.
 * @param getCount - Function that returns current message count
 * @param expectedCount - Expected number of messages
 * @param timeoutMs - Timeout in milliseconds (default: 500ms)
 * @returns Promise that resolves when count is reached or rejects on timeout
 */
export async function waitForMessageCount(
  getCount: () => number,
  expectedCount: number,
  timeoutMs = 500,
): Promise<void> {
  const startTime = Date.now();

  while (getCount() < expectedCount) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Timeout waiting for ${expectedCount} messages (received ${getCount()} after ${timeoutMs}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Helper to wait for a condition to be met with fail-fast timeout.
 * @param condition - Function that returns true when condition is met
 * @param timeoutMs - Timeout in milliseconds (default: 500ms)
 * @param errorMessage - Error message to throw on timeout
 * @returns Promise that resolves when condition is met or rejects on timeout
 */
export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 500,
  errorMessage = 'Condition not met',
): Promise<void> {
  const startTime = Date.now();

  while (!condition()) {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`${errorMessage} (after ${timeoutMs}ms)`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
