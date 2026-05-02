/**
 * End-to-end WebSocket transport HMAC authentication tests using real ws library.
 *
 * These tests verify HMAC authentication flow between client and server
 * without using mocks. Each test creates real WebSocket connections and
 * validates authentication behavior.
 */

import { describe, it, expect } from 'vitest';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { ServerTransport } from '../server-transport.js';
import { HmacAuth } from '../auth/hmac-auth.js';
import type { BusMessage } from '@makaio/bus-core';
import { createTestServer, waitForMessageCount } from './test-utils.js';

describe('HMAC authentication E2E', () => {
  const TEST_SECRET = 'test-secret-for-e2e';

  it('completes full HMAC challenge-response flow', async () => {
    const { wss, port } = await createTestServer();

    const serverAuth = new HmacAuth({ secret: TEST_SECRET, challengeTimeout: 5000 });
    const serverTransport = new ServerTransport({
      websocket: wss,
      auth: serverAuth,
    });
    await serverTransport.connect();

    // Small delay to ensure server is fully ready to handle connections
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      const clientAuth = new HmacAuth({ secret: TEST_SECRET, challengeTimeout: 5000 });
      const clientTransport = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        auth: clientAuth,
        autoReconnect: false,
      });

      // This should complete authentication successfully
      await clientTransport.connect();

      // Verify connection is established by sending a message
      const received: BusMessage[] = [];
      clientTransport.onReceive(async (msg) => {
        if (msg.type === 'event') received.push(msg);
      });

      await serverTransport.send({
        type: 'event',
        subject: 'auth-success',
        namespace: 'test',
        payload: { authenticated: true },
        messageId: 'msg-auth',
      });

      await waitForMessageCount(() => received.length, 1);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        namespace: 'test',
        subject: 'auth-success',
        payload: { authenticated: true },
      });

      await clientTransport.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 10000);

  it('rejects client with wrong secret', async () => {
    const { wss, port } = await createTestServer();

    const serverAuth = new HmacAuth({ secret: TEST_SECRET, challengeTimeout: 5000 });
    const serverTransport = new ServerTransport({
      websocket: wss,
      auth: serverAuth,
    });
    await serverTransport.connect();

    try {
      const clientAuth = new HmacAuth({ secret: 'wrong-secret', challengeTimeout: 5000 });
      const clientTransport = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        auth: clientAuth,
        autoReconnect: false,
      });

      // Authentication should fail
      await expect(clientTransport.connect()).rejects.toThrow();

      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 10000);

  it('handles concurrent client authentication', async () => {
    const { wss, port } = await createTestServer();

    const serverAuth = new HmacAuth({ secret: TEST_SECRET, challengeTimeout: 5000 });
    const serverTransport = new ServerTransport({
      websocket: wss,
      auth: serverAuth,
    });
    await serverTransport.connect();

    // Small delay to ensure server is fully ready
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      // Create 3 clients that will authenticate concurrently
      const clientTransport1 = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        auth: new HmacAuth({ secret: TEST_SECRET, challengeTimeout: 5000 }),
        autoReconnect: false,
      });
      const clientTransport2 = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        auth: new HmacAuth({ secret: TEST_SECRET, challengeTimeout: 5000 }),
        autoReconnect: false,
      });
      const clientTransport3 = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        auth: new HmacAuth({ secret: TEST_SECRET, challengeTimeout: 5000 }),
        autoReconnect: false,
      });

      // All clients should authenticate successfully in parallel
      await Promise.all([clientTransport1.connect(), clientTransport2.connect(), clientTransport3.connect()]);

      // Verify all clients can receive messages
      const received1: BusMessage[] = [];
      const received2: BusMessage[] = [];
      const received3: BusMessage[] = [];

      clientTransport1.onReceive(async (msg) => {
        if (msg.type === 'event') received1.push(msg);
      });
      clientTransport2.onReceive(async (msg) => {
        if (msg.type === 'event') received2.push(msg);
      });
      clientTransport3.onReceive(async (msg) => {
        if (msg.type === 'event') received3.push(msg);
      });

      await serverTransport.send({
        type: 'event',
        subject: 'concurrent-auth',
        namespace: 'test',
        payload: { message: 'all authenticated' },
        messageId: 'msg-concurrent',
      });

      await Promise.all([
        waitForMessageCount(() => received1.length, 1),
        waitForMessageCount(() => received2.length, 1),
        waitForMessageCount(() => received3.length, 1),
      ]);

      // All clients should receive the message
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received3).toHaveLength(1);

      expect(received1[0]).toMatchObject({
        namespace: 'test',
        subject: 'concurrent-auth',
        payload: { message: 'all authenticated' },
      });
      expect(received2[0]).toMatchObject({
        namespace: 'test',
        subject: 'concurrent-auth',
        payload: { message: 'all authenticated' },
      });
      expect(received3[0]).toMatchObject({
        namespace: 'test',
        subject: 'concurrent-auth',
        payload: { message: 'all authenticated' },
      });

      await clientTransport1.disconnect();
      await clientTransport2.disconnect();
      await clientTransport3.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 10000);
});
