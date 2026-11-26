import { CorrelationTracker, serializeTransportError, TimeoutError, type BusBroadcastMessage } from '@makaio/bus-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { BroadcastAggregator } from '../broadcast-aggregator.js';
import { ClientRegistry } from '../client-registry.js';
import { ServerBoundaryAccess } from '../server-boundary-access.js';
import { normalizeClientBroadcastTimeout } from '../server-client-setup.js';
import { createInboundMessageHandler, type MessageHandlerDeps } from '../server-message-handler.js';
import { closeServer, createTestServer, waitForOpen } from './test-utils.js';

const broadcast: BusBroadcastMessage = {
  type: 'broadcast',
  namespace: 'test',
  subject: 'fanout',
  correlationId: 'caller',
  messageId: 'broadcast',
  payload: {},
};

describe('inbound broadcast authorization budget', () => {
  const host = '127.0.0.1';
  const cleanups: Array<() => void | Promise<void>> = [];

  /**
   * Open a fresh WebSocket connection and track its client through teardown.
   * @param wss - Listening WebSocket server.
   * @param port - Local port assigned to the server.
   * @returns Open server-side socket.
   */
  async function openSocket(wss: WebSocketServer, port: number): Promise<WebSocket> {
    const connected = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
    const client = new WebSocket(`ws://${host}:${port}`, { agent: false });
    const closed = new Promise<void>((resolve) => client.once('close', () => resolve()));
    cleanups.push(() => {
      client.terminate();
      return closed;
    });
    await waitForOpen(client);
    return connected;
  }

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
    vi.useRealTimers();
  });

  /**
   * Exercise the inbound handler with an authorized subscriber and controlled authorization time.
   * @param message - Wire broadcast sent by the caller.
   * @returns The local deliveries and frames that the handler sent.
   */
  async function dispatch(message: BusBroadcastMessage) {
    const { wss, port } = await createTestServer({ host });
    cleanups.push(() => closeServer(wss));
    const sender = await openSocket(wss, port);
    const recipient = await openSocket(wss, port);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let now = 1_000;
    const access = new ServerBoundaryAccess('websocket', undefined, async ({ operation }) => {
      if (operation === 'send') now += 20;
      if (operation === 'handle') {
        entered.resolve();
        await released.promise;
      }
    });
    const registry = new ClientRegistry();
    registry.addClient(sender);
    registry.addClient(recipient);
    const senderFrames: unknown[] = [];
    const recipientFrames: unknown[] = [];
    const localBroadcasts: BusBroadcastMessage[] = [];
    const aggregator = new BroadcastAggregator({});
    cleanups.push(() => aggregator.cleanup());
    const deps: MessageHandlerDeps = {
      access,
      registry,
      auth: undefined,
      correlations: new CorrelationTracker(),
      broadcastAggregator: aggregator,
      handlers: new Set([
        async (frame) => {
          if (frame.type === 'broadcast') localBroadcasts.push(frame);
        },
      ]),
      now: () => now,
      normalizeBroadcastTimeout: normalizeClientBroadcastTimeout,
      sendSafely: (socket, frame) => {
        socket.send(frame);
        (socket === sender ? senderFrames : recipientFrames).push(JSON.parse(frame));
        return true;
      },
      debug: false,
    };
    await createInboundMessageHandler(
      recipient,
      deps,
    )(
      JSON.stringify({
        type: 'subscribe',
        subjects: { 'test.fanout': [100] },
        deliveryClasses: { 'test.fanout': 'relayable' },
      }),
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = createInboundMessageHandler(sender, deps)(JSON.stringify(message));
    const authorizing = await Promise.race([entered.promise.then(() => true), pending.then(() => false)]);
    now += 30;
    released.resolve();
    await pending;
    expect(authorizing).toBe(true);
    return { senderFrames, recipientFrames, localBroadcasts };
  }

  it('rejects an exhausted deadline before peer or local dispatch', async () => {
    const { senderFrames, recipientFrames, localBroadcasts } = await dispatch({ ...broadcast, timeout: 25 });

    expect(senderFrames).toEqual([
      {
        type: 'broadcast-response',
        correlationId: 'caller',
        error: serializeTransportError(new TimeoutError('test.fanout', 25)),
      },
    ]);
    expect(recipientFrames).toEqual([]);
    expect(localBroadcasts).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { message: { ...broadcast, timeout: 90_000 }, aggregationTimeout: 60_000 },
    { message: broadcast, aggregationTimeout: 5_000 },
    { message: { ...broadcast, timeout: 0 }, aggregationTimeout: 5_000 },
    { message: { ...broadcast, timeout: -1 }, aggregationTimeout: 5_000 },
  ])('charges local dispatch for authorization with wire timeout $message.timeout', async ({
    message,
    aggregationTimeout,
  }) => {
    const { senderFrames, recipientFrames, localBroadcasts } = await dispatch(message);

    const { correlationId } = localBroadcasts[0];
    expect(localBroadcasts).toEqual([{ ...message, correlationId, timeout: aggregationTimeout - 50 }]);
    expect(recipientFrames).toEqual([{ ...message, correlationId, metadata: { principal: expect.any(Object) } }]);

    vi.advanceTimersByTime(aggregationTimeout - 1);
    expect(senderFrames).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(senderFrames).toEqual([{ type: 'broadcast-response', correlationId: 'caller', results: [] }]);
  });
});
