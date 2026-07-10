/**
 * Integration tests for the heartbeat liveness watchdog (issue #374).
 *
 * Uses the real `ws` package on both ends. A server created with
 * `autoPong: false` never answers ping frames even though the TCP connection
 * and `readyState === 1` stay fully alive — the exact dead-established
 * connection the watchdog must detect. A default server (`autoPong: true`)
 * answers every probe and must never be killed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import type { WebSocketLike } from '../types.js';
import { closeServer, createTestServer, waitForCondition } from './test-utils.js';

describe('WebSocketClientTransport — heartbeat watchdog (integration)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('probes a healthy connection without killing it', { timeout: 10_000 }, async () => {
    const { wss, port } = await createTestServer({ autoPong: true });
    cleanups.push(() => closeServer(wss));

    let pongCount = 0;
    const onDisconnected = vi.fn();
    const transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
      heartbeat: { intervalMs: 50, timeoutMs: 50 },
      onDisconnected,
      // Create the real socket ourselves so we can observe pong frames.
      createWebSocket: (url) => {
        const ws = new WebSocket(url);
        ws.on('pong', () => {
          pongCount++;
        });
        return ws as WebSocketLike;
      },
    });
    cleanups.push(() => transport.disconnect());

    await transport.connect();
    expect(transport.isReady()).toBe(true);

    // The connection is idle, so probes MUST flow — and the server's
    // automatic pongs must be observed on the client socket.
    await waitForCondition(() => pongCount >= 1, 2000, 'no pong observed — watchdog never sent ping probes');

    // Hold for ≥ 4 more interval cycles: the healthy connection must survive.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(transport.isReady()).toBe(true);
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it('detects a dead-established connection (server never pongs)', { timeout: 10_000 }, async () => {
    const { wss, port } = await createTestServer({ autoPong: false });
    cleanups.push(() => closeServer(wss));

    const onDisconnected = vi.fn();
    const transport = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      autoReconnect: false,
      heartbeat: { intervalMs: 50, timeoutMs: 50 },
      onDisconnected,
    });
    cleanups.push(() => transport.disconnect());

    await transport.connect();
    expect(transport.isReady()).toBe(true);

    // The TCP connection stays fully alive and readyState stays 1 — only the
    // watchdog's unanswered probes can reveal that the peer is unresponsive.
    await waitForCondition(
      () => onDisconnected.mock.calls.length >= 1,
      3000,
      'watchdog did not detect the dead-established connection',
    );

    await transport.disconnect();
  });
});
