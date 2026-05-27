/**
 * Integration tests for BusServerTransportProvider — real WebSocket upgrade mechanics.
 *
 * These tests exercise actual HTTP upgrade handling end-to-end using real
 * Node.js HTTP servers, real `ws` WebSocket servers, and real WebSocket
 * client connections. No module mocks are used so the full upgrade path
 * from TCP socket through the `ws` library is exercised.
 *
 * Scenarios:
 * - A WebSocket connection to `/bus` is accepted and reaches OPEN state.
 * - A WebSocket connection to a non-bus path is forwarded to downstream
 *   upgrade listeners without the bus handler destroying the socket.
 */

import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createBusContext, createBusInstance } from '@makaio/bus-core';
import { closeHttpServer, listenOnLoopback } from './__tests__/http-test-helpers.js';
import { BusServerTransportProvider } from './bus-server-transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a WebSocket to reach OPEN state or reject if an error fires first.
 * @param ws - WebSocket instance to observe.
 */
async function waitForOpen(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BusServerTransportProvider — WebSocket upgrade integration', () => {
  it('accepts a real WebSocket upgrade on /bus and reaches OPEN state', async () => {
    const server = createServer();
    const port = await listenOnLoopback(server);
    // Use an isolated bus instance to avoid polluting the global singleton.
    const bus = createBusInstance({ context: createBusContext() });
    const transport = new BusServerTransportProvider({
      httpServer: server,
    });

    await transport.connect(bus, 'machine-integration');

    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/bus`);
      await waitForOpen(ws);

      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      await transport.disconnect();
      await closeHttpServer(server);
    }
  }, 10_000);

  it('passes non-bus upgrade requests to downstream listeners without destroying the socket', async () => {
    const server = createServer();
    const port = await listenOnLoopback(server);
    const bus = createBusInstance({ context: createBusContext() });
    const transport = new BusServerTransportProvider({
      httpServer: server,
    });

    await transport.connect(bus, 'machine-integration');

    // Register a secondary upgrade listener after the bus transport.
    // The bus handler must not consume or destroy the socket for non-bus
    // paths so this handler is reachable.
    let secondaryHandlerReached = false;
    const secondaryHandler = (req: IncomingMessage, socket: Duplex): void => {
      if (req.url === '/other') {
        secondaryHandlerReached = true;
        // Send a 400 so the WebSocket client closes cleanly.
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.end();
      }
    };

    try {
      server.on('upgrade', secondaryHandler);

      await new Promise<void>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
        // The secondary handler responds with HTTP 400, which the ws client
        // surfaces as 'unexpected-response'. An 'error' or 'close' event
        // also indicates the secondary handler was reached.
        ws.once('unexpected-response', () => resolve());
        ws.once('error', () => resolve());
        ws.once('close', () => resolve());
      });

      expect(secondaryHandlerReached).toBe(true);
    } finally {
      server.off('upgrade', secondaryHandler);
      await transport.disconnect();
      await closeHttpServer(server);
    }
  }, 10_000);
});
