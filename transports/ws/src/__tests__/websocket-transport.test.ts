/**
 * WebSocket transport tests.
 *
 * Tests WebSocketTransport-specific behavior:
 * - Client/server mode behavior
 * - HMAC authentication
 * - Correlation tracking
 * - Reconnect lifecycle
 *
 * Note: Generic transport interface compliance is tested via integration tests
 * in core/bus-core/src/__tests__/transport.integration.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createWebSocketTransport } from '../index.js';
import { ServerTransport } from '../server-transport.js';
import { HmacAuth } from '../auth/hmac-auth.js';
import { MockWebSocket, MockWebSocketServer, computeHmacSignature } from './test-helpers.js';
import { waitForCondition } from './test-utils.js';
import type { BusEventMessage, BusRequestMessage } from '@makaio/bus-core';

/**
 * Create a `WebSocketClientTransport` that wraps a pre-created `MockWebSocket`.
 *
 * Mirrors the pattern used by `createWebSocketTransport(client)` in `index.ts`:
 * callers inject the socket via `createWebSocket` and disable auto-reconnect
 * so the transport treats the socket as externally owned.
 * @param ws - Pre-created MockWebSocket instance
 * @param options - Additional transport options forwarded to `WebSocketClientTransport`
 * @returns Configured transport instance
 */
function makeMockTransport(
  ws: MockWebSocket,
  options: Omit<
    ConstructorParameters<typeof WebSocketClientTransport>[0],
    'url' | 'createWebSocket' | 'autoReconnect'
  > = {},
): WebSocketClientTransport {
  return new WebSocketClientTransport({
    ...options,
    url: '<pre-connected>',
    createWebSocket: () => ws,
    autoReconnect: false,
  });
}

// ============================================================================
// CLIENT MODE BEHAVIOR
// ============================================================================

describe('Client mode behavior', () => {
  it('rejects missing mode at runtime', () => {
    const ws = new MockWebSocket();

    expect(() =>
      createWebSocketTransport({
        websocket: ws,
      } as unknown as Parameters<typeof createWebSocketTransport>[0]),
    ).toThrow('mode must be "client" or "server"');
  });

  it('rejects invalid mode at runtime', () => {
    const ws = new MockWebSocket();

    expect(() =>
      createWebSocketTransport({
        mode: 'browser',
        websocket: ws,
      } as unknown as Parameters<typeof createWebSocketTransport>[0]),
    ).toThrow('mode must be "client" or "server"');
  });

  it('rejects client mode with a server-shaped socket at runtime', () => {
    const wss = new MockWebSocketServer();

    expect(
      () =>
        createWebSocketTransport({
          mode: 'client',
          websocket: wss,
        } as unknown as Parameters<typeof createWebSocketTransport>[0]),
      // Substring match — actual message has "WebSocket transport " prefix.
    ).toThrow('client mode requires a websocket with addEventListener/removeEventListener');
  });

  it('rejects server mode with a client-shaped socket at runtime', () => {
    const ws = new MockWebSocket();

    expect(
      () =>
        createWebSocketTransport({
          mode: 'server',
          websocket: ws,
        } as unknown as Parameters<typeof createWebSocketTransport>[0]),
      // Substring match — actual message has "WebSocket transport " prefix.
    ).toThrow('server mode requires a websocket with on/off listener methods');
  });

  it('rejects legacy connectionOptions for pre-created WebSocket clients', () => {
    const ws = new MockWebSocket();

    expect(() =>
      createWebSocketTransport({
        mode: 'client',
        websocket: ws,
        connectionOptions: { reconnect: true },
      } as unknown as Parameters<typeof createWebSocketTransport>[0]),
    ).toThrow('does not support connectionOptions');
  });

  it('cleans up listeners on disconnect', async () => {
    const ws = new MockWebSocket();
    const transport = makeMockTransport(ws);

    try {
      await transport.connect();

      const initialListeners = ws.listeners.get('message')?.size ?? 0;
      expect(initialListeners).toBeGreaterThan(0);

      await transport.disconnect();

      const afterListeners = ws.listeners.get('message')?.size ?? 0;
      expect(afterListeners).toBe(0);
    } finally {
      await transport.disconnect();
    }
  });

  it('throws error when sending while disconnected', async () => {
    const ws = new MockWebSocket();
    const transport = makeMockTransport(ws);

    try {
      await transport.connect();
      await transport.disconnect();

      const eventMessage: BusEventMessage = {
        type: 'event',
        namespace: 'test',
        subject: 'event',
        payload: {},
        messageId: 'evt-fail',
      };

      await expect(transport.send(eventMessage)).rejects.toThrow('WebSocketClientTransport: not connected');
    } finally {
      await transport.disconnect();
    }
  });

  it('replays subscription filters on reconnect', async () => {
    const ws = new MockWebSocket();
    const transport = makeMockTransport(ws);

    try {
      await transport.connect();
      const subscribe = transport.subscribe('approval.request', { sessionId: 'session-1' });
      await waitForCondition(() => ws.sentMessages.length > 0, 1000, 'subscription message was not sent');
      const subscribeMessage = JSON.parse(ws.sentMessages.at(-1)!) as { ackId?: string };
      ws.receiveMessage(JSON.stringify({ type: 'subscription-ack', ackId: subscribeMessage.ackId }));
      await subscribe;
      ws.clearSentMessages();

      await transport.disconnect();
      ws.readyState = 1;
      await transport.connect();

      expect(ws.sentMessages).toHaveLength(1);
      expect(JSON.parse(ws.sentMessages[0])).toEqual({
        type: 'subscribe',
        subjects: { 'approval.request': [] },
        filters: { 'approval.request': { sessionId: 'session-1' } },
      });
    } finally {
      await transport.disconnect();
    }
  });

  it('rejects manual reconnect on a closed caller-owned socket', async () => {
    const ws = new MockWebSocket();
    const onDisconnected = vi.fn();
    const transport = makeMockTransport(ws, { onDisconnected });

    try {
      await transport.connect();

      ws.close();

      // The close listener is async (drains in-flight messages before clearing
      // reconnectAbort). Wait for it to fire onDisconnected so we know it has
      // completed and reconnectAbort is cleared, allowing connect() to proceed.
      await waitForCondition(() => onDisconnected.mock.calls.length > 0, 1000, 'onDisconnected not called after close');

      // After the close listener finishes it clears reconnectAbort, allowing
      // connect() to be called again. connectOnce then calls wsFactory which
      // returns the closed socket — waitForSocketOpen rejects immediately.
      await expect(transport.connect()).rejects.toThrow('WebSocket closed before opening');
    } finally {
      await transport.disconnect();
    }
  });

  it('rejects a pending connect when the socket closes before opening', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 0;
    const transport = makeMockTransport(ws);

    try {
      const pendingConnect = transport.connect();

      ws.close();

      await expect(pendingConnect).rejects.toThrow('WebSocket closed before opening');
      // After the failed connect, reconnectAbort is cleared so connect() can
      // be called again. The socket is still closed so it rejects again.
      await expect(transport.connect()).rejects.toThrow('WebSocket closed before opening');
    } finally {
      await transport.disconnect();
    }
  });

  it('rejects a second public connect while the first one is still in flight', async () => {
    const ws = new MockWebSocket();
    ws.readyState = 0;
    const onConnected = vi.fn();
    const transport = makeMockTransport(ws, { onConnected });

    try {
      const firstConnect = transport.connect();

      await expect(transport.connect()).rejects.toThrow('WebSocketClientTransport: already connected');

      ws.readyState = 1;
      ws.emit('open', {});

      await expect(firstConnect).resolves.toBeUndefined();
      expect(onConnected).toHaveBeenCalledTimes(1);
    } finally {
      await transport.disconnect();
    }
  });

  it('notifies onDisconnected when socket closes unexpectedly', async () => {
    const ws = new MockWebSocket();
    const onDisconnected = vi.fn();
    const transport = makeMockTransport(ws, { onDisconnected });

    try {
      await transport.connect();
      ws.close();

      // The close listener is async (drains in-flight messages before notifying);
      // wait for it to settle before asserting.
      await waitForCondition(() => onDisconnected.mock.calls.length > 0, 1000, 'onDisconnected not called after close');
      expect(onDisconnected).toHaveBeenCalledTimes(1);
    } finally {
      await transport.disconnect();
    }
  });
});

// ============================================================================
// HMAC AUTHENTICATION
// ============================================================================

describe('HMAC authentication', () => {
  const TEST_SECRET = 'test-secret-key';

  it('client completes authentication flow', async () => {
    const ws = new MockWebSocket();
    const auth = new HmacAuth({ secret: TEST_SECRET });
    const transport = makeMockTransport(ws, { auth });

    try {
      const connectPromise = transport.connect();
      await new Promise((resolve) => setTimeout(resolve, 50));

      ws.receiveMessage(JSON.stringify({ type: 'auth-challenge', nonce: 'test-nonce' }));
      await new Promise((resolve) => setTimeout(resolve, 50));

      const responses = ws.sentMessages.filter((msg) => JSON.parse(msg).type === 'auth-response');
      expect(responses).toHaveLength(1);
      expect(JSON.parse(responses[0])).toHaveProperty('signature');

      ws.receiveMessage(JSON.stringify({ type: 'auth-result', success: true }));
      await expect(connectPromise).resolves.toBeUndefined();
    } finally {
      await transport.disconnect();
    }
  });

  it('server validates HMAC signatures', async () => {
    const wss = new MockWebSocketServer();
    const auth = new HmacAuth({ secret: TEST_SECRET });
    const transport = new ServerTransport({
      websocket: wss,
      auth,
    });

    try {
      await transport.connect();

      const client = new MockWebSocket();
      setTimeout(() => wss.simulateConnection(client), 50);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const challenges = client.sentMessages.filter((msg) => JSON.parse(msg).type === 'auth-challenge');
      expect(challenges.length).toBeGreaterThan(0);

      const challenge = JSON.parse(challenges[0]);
      const correctSignature = await computeHmacSignature(TEST_SECRET, challenge.nonce);

      client.receiveMessage(JSON.stringify({ type: 'auth-response', signature: correctSignature }));
      await new Promise((resolve) => setTimeout(resolve, 100));

      const results = client.sentMessages.filter((msg) => JSON.parse(msg).type === 'auth-result');
      expect(JSON.parse(results[0]).success).toBe(true);
    } finally {
      await transport.disconnect();
    }
  });
});

// ============================================================================
// CORRELATION TRACKING
// ============================================================================

describe('Correlation tracking', () => {
  it('request/response matching works', async () => {
    const ws = new MockWebSocket();
    const transport = makeMockTransport(ws);

    try {
      await transport.connect();

      const request: BusRequestMessage = {
        type: 'request',
        namespace: 'test',
        subject: 'request',
        payload: { query: 'test' },
        correlationId: 'corr-123',
        messageId: 'req-123',
      };

      const sendPromise = transport.send(request);
      setTimeout(() => {
        ws.receiveMessage(
          JSON.stringify({
            type: 'response',
            correlationId: 'corr-123',
            result: { answer: 42 },
          }),
        );
      }, 50);

      expect(await sendPromise).toEqual({ answer: 42 });
    } finally {
      await transport.disconnect();
    }
  });

  it('concurrent requests do not interfere', async () => {
    const ws = new MockWebSocket();
    const transport = makeMockTransport(ws);

    try {
      await transport.connect();

      const req1: BusRequestMessage = {
        type: 'request',
        subject: 'test',
        namespace: 'namespace',
        payload: { id: 1 },
        correlationId: 'c1',
        messageId: 'r1',
      };
      const req2: BusRequestMessage = {
        type: 'request',
        subject: 'test',
        namespace: 'namespace',
        payload: { id: 2 },
        correlationId: 'c2',
        messageId: 'r2',
      };

      const p1 = transport.send(req1);
      const p2 = transport.send(req2);

      setTimeout(() => {
        ws.receiveMessage(
          JSON.stringify({
            type: 'response',
            correlationId: 'c2',
            result: { id: 2, value: 'second' },
          }),
        );
        ws.receiveMessage(
          JSON.stringify({
            type: 'response',
            correlationId: 'c1',
            result: { id: 1, value: 'first' },
          }),
        );
      }, 50);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual({ id: 1, value: 'first' });
      expect(r2).toEqual({ id: 2, value: 'second' });
    } finally {
      await transport.disconnect();
    }
  });
});
