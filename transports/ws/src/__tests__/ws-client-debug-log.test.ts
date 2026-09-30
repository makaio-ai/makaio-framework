/**
 * Debug-sink isolation tests: a failing `debugLog` must never change transport state.
 */

import { describe, expect, it, vi } from 'vitest';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createE2ERelayCodec } from '../e2e-relay-client-transport.js';
import { MockWebSocket, createPreSessionRelayAuth } from './test-helpers.js';
import { waitForCondition } from './test-utils.js';
import { buildRelayControlTestRegistry, createRelayControlTestHelpers } from './relay-control-test-registry.js';

const testRegistry = buildRelayControlTestRegistry();
const { createRelayControlEnvelope } = createRelayControlTestHelpers(testRegistry);

/**
 * Acknowledge the most recent subscription message sent over the mock socket.
 * @param mock - Mock socket that captured the subscription message
 */
async function acknowledgeLatestSubscription(mock: MockWebSocket): Promise<void> {
  await waitForCondition(() => mock.sentMessages.length > 0, 1000, 'subscription message was not sent');
  const message = JSON.parse(mock.sentMessages.at(-1)!) as { ackId?: string };
  mock.receiveMessage(JSON.stringify({ type: 'subscription-ack', ackId: message.ackId }));
}

/**
 * Connect a debug-enabled transport using the given sink and subscribe once.
 * @param debugLog - Sink under test
 * @returns The connected transport
 */
async function connectAndSubscribe(debugLog: (message: string) => void): Promise<WebSocketClientTransport> {
  const mock = new MockWebSocket();
  const transport = new WebSocketClientTransport({
    url: 'ws://localhost:9999',
    createWebSocket: () => mock,
    autoReconnect: false,
    debug: true,
    debugLog,
  });
  await transport.connect();
  const subscribe = transport.subscribe('topic.a');
  await acknowledgeLatestSubscription(mock);
  await subscribe;
  return transport;
}

describe('debugLog failure isolation', () => {
  it('connects and subscribes when the sink throws synchronously', async () => {
    const sink = vi.fn((): void => {
      throw new Error('sink boom');
    });
    const transport = await connectAndSubscribe(sink);

    expect(sink).toHaveBeenCalled();
    expect(transport.getSubscriptions()).toContain('topic.a');
    await transport.disconnect();
  });

  it('produces no unhandled rejection when the sink returns a rejected promise', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const sink = vi.fn(() => Promise.reject(new Error('async sink boom')) as unknown as void);
      const transport = await connectAndSubscribe(sink);
      await transport.disconnect();
      await new Promise((resolve) => setImmediate(resolve));

      expect(sink).toHaveBeenCalled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('still decodes a relay control envelope when the codec sink throws', async () => {
    const sink = vi.fn((): void => {
      throw new Error('codec sink boom');
    });
    const e2eAuth = await createPreSessionRelayAuth('codec-debug-throw');
    const { codec } = createE2ERelayCodec(e2eAuth, testRegistry, true, sink);

    const decoded = await codec.decode(
      createRelayControlEnvelope({
        type: 'event',
        subject: 'error',
        namespace: 'relay',
        payload: { code: 'connection_error', message: 'oops', timestamp: Date.now() },
        messageId: 'relay-ctrl-throw',
      }),
    );

    expect(sink).toHaveBeenCalled();
    expect(decoded).toMatchObject({ subject: 'error', namespace: 'relay' });
  });
});
