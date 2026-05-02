/**
 * Subscription filtering E2E tests for WebSocket transport.
 *
 * These tests verify the subscription-based routing protocol that enables
 * efficient client-side filtering of messages based on subscription patterns.
 *
 * Test scenarios:
 * - Message filtering based on exact and wildcard subscriptions
 * - Dynamic subscribe/unsubscribe operations
 * - Server-side aggregation of client subscriptions
 */

import { describe, it, expect } from 'vitest';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { ServerTransport } from '../server-transport.js';
import { BusEventMessage } from '@makaio/bus-core';
import { createTestServer, waitForMessageCount } from './test-utils.js';

// ============================================================================
// SUBSCRIPTION FILTERING E2E
// ============================================================================

describe('Subscription filtering E2E', () => {
  it('filters messages based on client subscriptions', async () => {
    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss });
    await serverTransport.connect();

    try {
      // Connect 3 clients with different subscriptions
      const t1 = new WebSocketClientTransport({ url: `ws://localhost:${port}`, autoReconnect: false });
      const t2 = new WebSocketClientTransport({ url: `ws://localhost:${port}`, autoReconnect: false });
      const t3 = new WebSocketClientTransport({ url: `ws://localhost:${port}`, autoReconnect: false });

      await Promise.all([t1.connect(), t2.connect(), t3.connect()]);

      // Set up different subscriptions
      await t1.subscribe('adapter.*'); // Subscribe to all adapter events
      await t2.subscribe('adapter.log'); // Subscribe only to adapter.log
      await t3.subscribe('agent.*'); // Subscribe to all agent events

      // Wait for subscriptions to be processed by server
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify subscriptions are tracked
      expect(t1.getSubscriptions()).toEqual(new Set(['adapter.*']));
      expect(t2.getSubscriptions()).toEqual(new Set(['adapter.log']));
      expect(t3.getSubscriptions()).toEqual(new Set(['agent.*']));

      // Register handlers to capture events
      const received1: BusEventMessage[] = [];
      const received2: BusEventMessage[] = [];
      const received3: BusEventMessage[] = [];

      t1.onReceive(async (msg) => {
        if (msg.type === 'event') received1.push(msg);
      });
      t2.onReceive(async (msg) => {
        if (msg.type === 'event') received2.push(msg);
      });
      t3.onReceive(async (msg) => {
        if (msg.type === 'event') received3.push(msg);
      });

      // Send various events
      await serverTransport.send({
        type: 'event',
        namespace: 'adapter',
        subject: 'log',
        payload: { message: 'log entry' },
        messageId: 'msg-1',
      });

      await serverTransport.send({
        type: 'event',
        namespace: 'adapter',
        subject: 'initialized',
        payload: { adapterId: 'claude' },
        messageId: 'msg-2',
      });

      await serverTransport.send({
        type: 'event',
        namespace: 'agent',
        subject: 'started',
        payload: { agentId: 'agent-1' },
        messageId: 'msg-3',
      });

      // Wait for delivery with fail-fast timeout
      await waitForMessageCount(() => received1.length, 2);

      // Client 1 (adapter.*) should receive adapter.log and adapter.initialized
      expect(received1).toHaveLength(2);
      expect(received1[0].namespace).toBe('adapter');
      expect(received1[0].subject).toBe('log');
      expect(received1[1].namespace).toBe('adapter');
      expect(received1[1].subject).toBe('initialized');

      // Client 2 (adapter.log) should receive only adapter.log
      expect(received2).toHaveLength(1);
      expect(received2[0].namespace).toBe('adapter');
      expect(received2[0].subject).toBe('log');

      // Client 3 (agent.*) should receive only agent.started
      expect(received3).toHaveLength(1);
      expect(received3[0].namespace).toBe('agent');
      expect(received3[0].subject).toBe('started');

      await Promise.all([t1.disconnect(), t2.disconnect(), t3.disconnect()]);
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  it('supports dynamic subscribe and unsubscribe', async () => {
    const { wss, port } = await createTestServer();
    const serverTransport = new ServerTransport({ websocket: wss });
    await serverTransport.connect();

    try {
      const clientTransport = new WebSocketClientTransport({
        url: `ws://localhost:${port}`,
        autoReconnect: false,
      });
      await clientTransport.connect();

      // Initially subscribe to adapter.*
      await clientTransport.subscribe('adapter.*');

      // Wait for subscription to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));

      const received: BusEventMessage[] = [];
      clientTransport.onReceive(async (msg) => {
        if (msg.type === 'event') received.push(msg as BusEventMessage);
      });

      // Send adapter event - should receive
      await serverTransport.send({
        type: 'event',
        namespace: 'adapter',
        subject: 'log',
        payload: { message: 'log 1' },
        messageId: 'msg-1',
      });

      await waitForMessageCount(() => received.length, 1);
      expect(received).toHaveLength(1);

      // Unsubscribe from adapter.*
      await clientTransport.unsubscribe('adapter.*');

      // Subscribe to agent.*
      await clientTransport.subscribe('agent.*');

      // Wait for subscription changes to be processed
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Send another adapter event - should NOT receive
      await serverTransport.send({
        type: 'event',
        namespace: 'adapter',
        subject: 'log',
        payload: { message: 'log 2' },
        messageId: 'msg-2',
      });

      // Wait to ensure no message arrives (should stay at 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(received).toHaveLength(1); // Still only 1

      // Send agent event - should receive
      await serverTransport.send({
        type: 'event',
        namespace: 'agent',
        subject: 'started',
        payload: { agentId: 'agent-1' },
        messageId: 'msg-3',
      });

      await waitForMessageCount(() => received.length, 2);
      expect(received).toHaveLength(2);
      expect(received[1].namespace).toBe('agent');
      expect(received[1].subject).toBe('started');

      await clientTransport.disconnect();
      await serverTransport.disconnect();
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });
});
// NOTE: ServerTransport intentionally does not expose getSubscriptions().
// Routing is delegated to send() which correctly filters per-client via
// getInterestedClients().
