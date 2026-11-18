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
 * - Server-initiated request routing never re-sends a request whose outcome is unknown
 *   and keeps every attempt inside the caller's budget
 */

import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { WebSocketServer } from 'ws';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { ServerTransport } from '../server-transport.js';
import type { BusMessage, BusRequestMessage } from '@makaio/bus-core';
import { NO_HANDLER_ERROR_CODE, NoHandlerError, TimeoutError } from '@makaio/bus-core';
import { createTestServer, waitForCondition, waitForMessageCount } from './test-utils.js';

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

// ============================================================================
// SERVER-INITIATED REQUEST ROUTING E2E
// ============================================================================

describe('Server-initiated request routing E2E', () => {
  const subject = 'action';
  const namespace = 'test';

  let wss: WebSocketServer;
  let serverTransport: ServerTransport;
  let clients: WebSocketClientTransport[];
  /** Requests received per client, in client connection order. */
  let received: BusRequestMessage[][];

  const totalReceived = (): number => received.reduce((sum, requests) => sum + requests.length, 0);

  /**
   * Build a server-initiated request envelope.
   * @param correlationId - Correlation ID chosen by the caller
   * @returns Request envelope for `test.action`
   */
  function makeRequest(correlationId: string): BusRequestMessage {
    return { type: 'request', namespace, subject, payload: {}, correlationId, messageId: `msg-${correlationId}` };
  }

  /**
   * Answer the request a client received with "no handler" for `test.action`.
   * @param clientIndex - Index of the answering client
   */
  async function answerNoHandler(clientIndex: number): Promise<void> {
    await clients[clientIndex].send({
      type: 'response',
      correlationId: received[clientIndex][0].correlationId,
      error: {
        message: 'No handler registered for request subject "test.action"',
        code: NO_HANDLER_ERROR_CODE,
        data: { subject: 'test.action' },
      },
    });
  }

  beforeEach(async () => {
    const server = await createTestServer();
    wss = server.wss;
    serverTransport = new ServerTransport({ websocket: wss });
    await serverTransport.connect();

    // Two clients advertise the same request handler and record what reaches them.
    clients = [];
    received = [];
    for (let index = 0; index < 2; index++) {
      const client = new WebSocketClientTransport({ url: `ws://localhost:${server.port}`, autoReconnect: false });
      const requests: BusRequestMessage[] = [];
      client.onReceive(async (msg) => {
        if (msg.type === 'request') requests.push(msg);
      });
      await client.connect();
      // Resolves on the server's subscription-ack, so routing state is applied.
      await client.subscribe(`${namespace}.${subject}`, undefined, [0]);
      clients.push(client);
      received.push(requests);
    }
  });

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.disconnect()));
    await serverTransport.disconnect();
  });

  it('does not re-send a timed-out request to the next interested client', async () => {
    // The first client receives the request but never answers in time. The
    // caller sees a timeout of its request subject and budget, not of the
    // internal attempt correlation ID.
    const error = await serverTransport.send(makeRequest('corr-timeout'), 100).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ subject: 'test.action', timeoutMs: 100 });

    // A timeout is not evidence that the handler did not run: the request
    // must not reach a second client after the caller saw the timeout.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(totalReceived()).toBe(1);
  });

  it('cancels the in-flight attempt and stops routing when the caller cancels', async () => {
    // timeout 0: only cancellation can settle the request.
    const outcome = serverTransport.send(makeRequest('corr-cancel'), 0).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await waitForCondition(() => totalReceived() === 1, 500, 'request never reached a client');

    const cancellation = new Error('caller cancelled');
    serverTransport.cancelRequest('corr-cancel', cancellation);
    const settled = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve('pending'), 200))]);
    expect(settled).toBe(cancellation);

    // A late "no handler" reply for the cancelled attempt must not move the
    // request on to the next client.
    await answerNoHandler(received.findIndex((requests) => requests.length === 1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(totalReceived()).toBe(1);
  });

  it('gives the next client only the remaining budget after a late no-handler answer', async () => {
    const timeout = 400;
    const answerDelay = 300;
    const startedAt = Date.now();
    const outcome = serverTransport.send({ ...makeRequest('corr-late'), timeout }, timeout).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await waitForCondition(() => totalReceived() === 1, 500, 'request never reached a client');
    const firstIndex = received.findIndex((requests) => requests.length === 1);

    // The first client spends most of the budget before reporting no handler.
    await new Promise((resolve) => setTimeout(resolve, answerDelay));
    await answerNoHandler(firstIndex);
    const secondIndex = 1 - firstIndex;
    await waitForCondition(() => received[secondIndex].length === 1, 500, 'request never moved on');

    // The next client anchors its deadline from the wire budget, so it must not
    // get a fresh full timeout. Slack covers timer/clock rounding only.
    const slack = 5;
    const wireTimeout = received[secondIndex][0].timeout;
    expect(wireTimeout).toBeGreaterThan(0);
    expect(wireTimeout).toBeLessThanOrEqual(timeout - answerDelay + slack);

    // The server stops waiting at the shared deadline, not one full timeout
    // later, and reports the caller's subject and budget.
    const error = await outcome;
    expect(Date.now() - startedAt).toBeLessThan(timeout + answerDelay);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error).toMatchObject({ subject: 'test.action', timeoutMs: timeout });
  });

  it('propagates a no-handler cancellation reason unchanged instead of classifying it', async () => {
    // timeout 0: only answers and cancellation can settle the request.
    const outcome = serverTransport.send(makeRequest('corr-cancel-no-handler'), 0).then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await waitForCondition(() => totalReceived() === 1, 500, 'request never reached a client');
    const firstIndex = received.findIndex((requests) => requests.length === 1);
    await answerNoHandler(firstIndex);
    const secondIndex = 1 - firstIndex;
    await waitForCondition(() => received[secondIndex].length === 1, 500, 'request never moved on');

    // A cancellation reason shaped like a no-handler answer for the same
    // subject is still the caller's cancellation, not a client response.
    const cancellation = new NoHandlerError('test.action');
    serverTransport.cancelRequest('corr-cancel-no-handler', cancellation);
    const settled = await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve('pending'), 200))]);
    expect(settled).toBe(cancellation);
  });
});
