/**
 * End-to-end WebSocket transport tests using real ws library.
 *
 * These tests verify actual WebSocket communication between client and server
 * without using mocks. Each test creates real WebSocket connections and
 * validates message flow over the wire.
 *
 * Test scenarios:
 * - Event broadcast from server to multiple clients
 * - Request-response pattern across client-server
 */

import { describe, it, expect } from 'vitest';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { ServerTransport } from '../server-transport.js';
import type { BusMessage } from '@makaio/bus-core';
import { createTestServer, waitForMessageCount } from './test-utils.js';

// ============================================================================
// EVENT BROADCAST E2E
// ============================================================================

describe('Event broadcast E2E', () => {
  it('broadcasts events from server to multiple clients', async () => {
    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss });
    await serverTransport.connect();

    try {
      // Connect 3 clients — let WebSocketClientTransport own socket creation
      const t1 = new WebSocketClientTransport({ url: `ws://localhost:${port}`, autoReconnect: false });
      const t2 = new WebSocketClientTransport({ url: `ws://localhost:${port}`, autoReconnect: false });
      const t3 = new WebSocketClientTransport({ url: `ws://localhost:${port}`, autoReconnect: false });

      await Promise.all([t1.connect(), t2.connect(), t3.connect()]);

      // Register handlers to capture events
      const received1: BusMessage[] = [];
      const received2: BusMessage[] = [];
      const received3: BusMessage[] = [];

      t1.onReceive(async (msg) => {
        if (msg.type === 'event') received1.push(msg);
      });
      t2.onReceive(async (msg) => {
        if (msg.type === 'event') received2.push(msg);
      });
      t3.onReceive(async (msg) => {
        if (msg.type === 'event') received3.push(msg);
      });

      // Server broadcasts event
      const event = {
        type: 'event',
        namespace: 'test',
        subject: 'broadcast',
        payload: { message: 'hello all' },
        messageId: 'msg-1',
      } as const;

      await serverTransport.send(event);

      // Wait for delivery with fail-fast timeout
      await Promise.all([
        waitForMessageCount(() => received1.length, 1),
        waitForMessageCount(() => received2.length, 1),
        waitForMessageCount(() => received3.length, 1),
      ]);

      // All clients should receive
      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received3).toHaveLength(1);

      expect(received1[0]).toMatchObject({
        type: 'event',
        namespace: 'test',
        subject: 'broadcast',
        payload: { message: 'hello all' },
      });
      expect(received2[0]).toMatchObject({
        type: 'event',
        namespace: 'test',
        subject: 'broadcast',
        payload: { message: 'hello all' },
      });
      expect(received3[0]).toMatchObject({
        type: 'event',
        namespace: 'test',
        subject: 'broadcast',
        payload: { message: 'hello all' },
      });

      await Promise.all([t1.disconnect(), t2.disconnect(), t3.disconnect()]);
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});

// ============================================================================
// REQUEST-RESPONSE E2E
// ============================================================================

describe('Request-response E2E', () => {
  it('handles request-response across client-server', async () => {
    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss });
    await serverTransport.connect();

    try {
      const clientTransport = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        autoReconnect: false,
      });
      await clientTransport.connect();

      // Server handler responds to requests
      serverTransport.onReceive(async (msg) => {
        if (msg.type === 'request') {
          // Send response back through the transport
          // In a real implementation, the server would use its own send method
          // but we need to construct the response message manually here
          await serverTransport.send({
            type: 'response',
            correlationId: msg.correlationId,
            result: { answer: 42 },
          });
        }
      });

      // Client sends request
      const request = {
        type: 'request',
        namespace: 'test',
        subject: 'query',
        payload: { question: 'meaning of life' },
        correlationId: 'corr-123',
        messageId: 'req-1',
      } as const;

      const resultPromise = clientTransport.send(request);
      const result = await resultPromise;

      expect(result).toEqual({ answer: 42 });

      await clientTransport.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('handles multiple concurrent requests', async () => {
    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss });
    await serverTransport.connect();

    try {
      const clientTransport = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        autoReconnect: false,
      });
      await clientTransport.connect();

      // Server handler echoes back request ID
      serverTransport.onReceive(async (request) => {
        if (request.type === 'request') {
          const payload = request.payload as { id: number };
          await serverTransport.send({
            type: 'response',
            correlationId: request.correlationId,
            result: { id: payload.id, value: `response-${payload.id}` },
          });
        }
      });

      // Send 3 concurrent requests
      const promises = [
        clientTransport.send({
          type: 'request',
          namespace: 'test',
          subject: 'test',
          payload: { id: 1 },
          correlationId: 'corr-1',
          messageId: 'req-1',
        }),
        clientTransport.send({
          type: 'request',
          namespace: 'test',
          subject: 'test',
          payload: { id: 2 },
          correlationId: 'corr-2',
          messageId: 'req-2',
        }),
        clientTransport.send({
          type: 'request',
          namespace: 'test',
          subject: 'test',
          payload: { id: 3 },
          correlationId: 'corr-3',
          messageId: 'req-3',
        }),
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ id: 1, value: 'response-1' });
      expect(results[1]).toEqual({ id: 2, value: 'response-2' });
      expect(results[2]).toEqual({ id: 3, value: 'response-3' });

      await clientTransport.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
