/**
 * Integration tests for the connect-attempt timeout (issue #372).
 *
 * Reproduces the production failure mode with real sockets and the default
 * `ws` factory: a TCP server that accepts connections but never answers the
 * WebSocket upgrade (as an ingress in front of a stalled backend does). The
 * client must bound each connect attempt instead of wedging in CONNECTING.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createTestServer, waitForCondition } from './test-utils.js';

/** Handle for a blackhole TCP server created by {@link createBlackholeServer}. */
interface BlackholeServer {
  /** Bound port. */
  port: number;
  /** Number of TCP connections accepted so far. */
  accepts(): number;
  /** Destroy all accepted sockets and close the server. */
  close(): Promise<void>;
}

/**
 * Start a TCP server that accepts connections and swallows all bytes without
 * ever responding — the WebSocket upgrade never completes and no `error` or
 * `close` fires on the client side.
 * @param port - Port to bind; `0` picks an ephemeral port
 * @returns Blackhole server handle
 */
async function createBlackholeServer(port: number): Promise<BlackholeServer> {
  const sockets: Socket[] = [];
  let accepted = 0;
  const server: Server = createServer((socket) => {
    accepted++;
    sockets.push(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Failed to get blackhole server address');
  }

  return {
    port: address.port,
    accepts: () => accepted,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe('WebSocketClientTransport — blackholed upgrade (integration)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('bounds the initial connect() against a server that never answers the upgrade', { timeout: 5000 }, async () => {
    const blackhole = await createBlackholeServer(0);
    cleanups.push(() => blackhole.close());

    const transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${blackhole.port}`,
      autoReconnect: false,
      connectTimeoutMs: 300,
    });
    cleanups.push(() => transport.disconnect());

    // Accept either the transport-level bound or the ws handshakeTimeout —
    // both enforce the same invariant at different layers.
    await expect(transport.connect()).rejects.toThrow(/timed out|handshake/i);
  });

  it('keeps reconnecting through a blackholed upgrade instead of wedging', { timeout: 15_000 }, async () => {
    const { wss, port } = await createTestServer();

    const transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      autoReconnect: { baseMs: 100, maxMs: 200 },
      connectTimeoutMs: 300,
    });
    cleanups.push(() => transport.disconnect());

    await transport.connect();
    expect(transport.isReady()).toBe(true);

    // Replace the healthy server with a blackhole on the same port.
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    const blackhole = await createBlackholeServer(port);
    cleanups.push(() => blackhole.close());

    // The reconnect loop must keep producing attempts against the blackhole
    // instead of wedging forever inside the first never-settling upgrade.
    await waitForCondition(() => blackhole.accepts() >= 2, 10_000, 'reconnect loop wedged after blackholed upgrade');
  });
});
