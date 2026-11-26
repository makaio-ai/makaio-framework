import { once } from 'node:events';
import {
  type BoundaryAccessPolicy,
  ConnectionLostError,
  NO_BOUNDARY_ACCESS_CHECK,
  type BusMessage,
  type BusRequestMessage,
  type BusSubscribeMessage,
} from '@makaio/bus-core';
import { CorePartyKind, type TransportRequestOrigin } from '@makaio/core';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { ConnectionExchangeAuth } from '../auth/connection-exchange-auth.js';
import { HmacAuth } from '../auth/hmac-auth.js';
import { ServerTransport } from '../server-transport.js';
import { createTestServer, waitForOpen } from './test-utils.js';

class FailingRetirementAuth extends ConnectionExchangeAuth {
  public override bindExchangeRetirement(
    ...[socket, _retire, forceDetach]: Parameters<ConnectionExchangeAuth['bindExchangeRetirement']>
  ): void {
    super.bindExchangeRetirement(
      socket,
      () => {
        throw new Error('Injected retirement failure before detaching the session');
      },
      forceDetach,
    );
  }
}

class RepeatedRetirementAuth extends ConnectionExchangeAuth {
  public override bindExchangeRetirement(
    ...[socket, retire, forceDetach]: Parameters<ConnectionExchangeAuth['bindExchangeRetirement']>
  ): void {
    super.bindExchangeRetirement(
      socket,
      (...args) => {
        retire(...args);
        retire(...args);
      },
      forceDetach,
    );
  }
}

it.each([
  { scenario: 'the peer stops reading after the final request', ExchangeAuth: ConnectionExchangeAuth },
  { scenario: 'retirement throws before detaching the session', ExchangeAuth: FailingRetirementAuth },
  { scenario: 'a paused peer is retired twice', ExchangeAuth: RepeatedRetirementAuth },
])('terminates a retired exchange when $scenario', async ({ ExchangeAuth }) => {
  const { wss, port } = await createTestServer({ host: '127.0.0.1' });
  const revocationKey = 'exchange-session';
  const auth = new ExchangeAuth(new HmacAuth({ secret: 'unused-legacy-credential' }), {
    maxPendingExchanges: 1,
    maxBytes: 1024,
    refusal: '{}',
    async admit(_frame, { connectionId }) {
      return {
        reply: '{}',
        caller: { kind: 'test.peer', id: connectionId },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        revocationKey,
        hostSignal: new AbortController().signal,
      };
    },
  });
  const accepted = Promise.withResolvers<WebSocket>();
  wss.prependOnceListener('connection', (socket) => {
    auth.register(socket, { encrypted: true }, () => socket.terminate());
    accepted.resolve(socket);
  });
  const server = new ServerTransport({ websocket: wss, auth, checkBoundaryAccess: NO_BOUNDARY_ACCESS_CHECK });
  const routed = Promise.withResolvers<{ correlationId: string; origin: TransportRequestOrigin }>();
  const requests: string[] = [];
  server.onReceive(async (message, context) => {
    if (message.type !== 'request') return;
    requests.push(message.messageId);
    if (context?.requestOrigin) {
      routed.resolve({ correlationId: message.correlationId, origin: context.requestOrigin });
    }
  });
  await server.connect();

  const peer = new WebSocket(`ws://127.0.0.1:${port}`);
  try {
    const ready = Promise.withResolvers<void>();
    peer.on('message', (frame) => {
      if (frame.toString() === '{"type":"subscribe-sync-complete"}') ready.resolve();
    });
    await waitForOpen(peer);
    peer.send('{}');
    await ready.promise;

    const request: BusRequestMessage = {
      type: 'request',
      namespace: 'test',
      subject: 'finish',
      messageId: 'final-message',
      correlationId: 'final-request',
      payload: {},
    };
    peer.pause();
    peer.send(JSON.stringify(request));
    const { correlationId, origin } = await routed.promise;
    const nativeSocket = await accepted.promise;
    const nativeClosed = once(nativeSocket, 'close');
    const closeListeners = nativeSocket.listenerCount('close');
    const handoff = ExchangeAuth === ConnectionExchangeAuth;
    server.invalidateExchangeSessions(revocationKey, undefined, handoff ? origin : undefined);
    expect(server.getConnectionCount()).toBe(0);
    if (handoff) {
      expect(await server.send({ type: 'response', correlationId, result: 'committed' })).toBe(true);
      expect(nativeSocket.readyState).toBe(WebSocket.CLOSING);
    }
    if (ExchangeAuth === RepeatedRetirementAuth) {
      expect(nativeSocket.listenerCount('close')).toBe(closeListeners + 1);
    }
    peer.send(JSON.stringify({ ...request, messageId: 'follow-up-message', correlationId: 'follow-up-request' }));
    await expect(nativeClosed).resolves.toEqual([1006, expect.any(Buffer)]);
    expect(requests).toEqual([request.messageId]);
  } finally {
    peer.resume();
    peer.terminate();
    await server.disconnect();
  }
});

const responseProbe: BusRequestMessage = {
  type: 'request',
  namespace: 'test',
  subject: 'answer',
  messageId: 'host-probe',
  correlationId: 'host-probe',
  payload: {},
};
const eventProbe = { type: 'event', namespace: 'test', subject: 'changed', messageId: 'event', payload: {} } as const;
const subscriptionProbe: BusSubscribeMessage = {
  type: 'subscribe',
  subjects: { 'test.answer': [0] },
  deliveryClasses: { 'test.answer': 'first-hop-only' },
  ackId: 'worker-ack',
};
const revokedSubscription = { ...subscriptionProbe, subjects: { 'test.late': [0] } };
const WireRequest = z.object({ type: z.literal('request'), correlationId: z.string() });

/**
 * Advertise the live request handler before asking the host to route to it.
 * @param peer - Authenticated worker.
 */
async function advertiseResponseHandler(peer: WebSocket): Promise<void> {
  const ack = once(peer, 'message');
  peer.send(JSON.stringify(subscriptionProbe));
  const [data] = await ack;
  expect(JSON.parse(String(data))).toEqual({ type: 'subscription-ack', ackId: subscriptionProbe.ackId });
}

/**
 * Start a genuine host request and prepare its response after the worker sees it.
 * @param server - Host transport.
 * @param peer - Authenticated worker.
 * @returns The reply frame and the host-side request settlement.
 */
async function pendingWorkerResponse(server: ServerTransport, peer: WebSocket) {
  await advertiseResponseHandler(peer);
  const received = once(peer, 'message');
  const result = server.send(responseProbe).catch((error: unknown) => error);
  const [data] = await received;
  const { correlationId } = WireRequest.parse(JSON.parse(String(data)));
  return { reply: { type: 'response', correlationId, result: 'worker response' }, result };
}

it.each(['event', 'subscribe', 'response'] as const)('retires a worker before applying a revoked %s', async (type) => {
  let authorized = true;
  let checks = 0;
  const { peer, server, close } = await connectOrderedPeer(async () => {
    checks += 1;
    return authorized;
  });
  const applied: BusMessage['type'][] = [];
  const eventApplied = Promise.withResolvers<void>();
  server.onReceive(async (message) => {
    applied.push(message.type);
    if (message.type === 'event') eventApplied.resolve();
  });
  try {
    if (type === 'event') {
      peer.send(JSON.stringify(eventProbe));
      await eventApplied.promise;
    }
    if (type === 'subscribe') await advertiseResponseHandler(peer);
    const pending = type === 'response' ? await pendingWorkerResponse(server, peer) : undefined;
    applied.length = 0;

    // Change authority without calling the transport's retirement notification.
    authorized = false;
    const checkedBeforeHeartbeat = checks;
    const pong = once(peer, 'pong');
    peer.send(JSON.stringify({ type: 'heartbeat' }));
    peer.ping();
    await pong;
    expect(checks).toBe(checkedBeforeHeartbeat);
    expect(server.getConnectionCount()).toBe(1);
    expect(applied).toEqual([]);

    const closed = once(peer, 'close');
    peer.send(JSON.stringify(pending?.reply ?? (type === 'event' ? eventProbe : revokedSubscription)));
    await expect(closed).resolves.toEqual([1008, expect.any(Buffer)]);
    expect(checks).toBe(checkedBeforeHeartbeat + 1);
    expect(server.getConnectionCount()).toBe(0);
    expect(applied).not.toContain('event');
    expect(applied).not.toContain('subscribe');
    if (pending !== undefined) await expect(pending.result).resolves.toBeInstanceOf(ConnectionLostError);
  } finally {
    await close();
  }
});

/**
 * Start a real socket with optional owner verification and an ingress observer.
 * @param verifyRunSession - Owner verifier, when this is a protected session.
 * @param checkBoundaryAccess - Optional independent boundary policy.
 * @returns The connected pair and its cleanup.
 */
async function connectOrderedPeer(
  verifyRunSession?: ConstructorParameters<typeof ConnectionExchangeAuth>[1]['verifyRunSession'],
  checkBoundaryAccess: BoundaryAccessPolicy = NO_BOUNDARY_ACCESS_CHECK,
) {
  const maxBytes = 1024 * 1024;
  const { wss, port } = await createTestServer({ host: '127.0.0.1', maxPayload: maxBytes });
  const accepted = Promise.withResolvers<WebSocket>();
  const auth = new ConnectionExchangeAuth(new HmacAuth({ secret: 'unused-legacy-credential' }), {
    maxPendingExchanges: 1,
    maxBytes,
    refusal: '{}',
    verifyRunSession,
    async admit() {
      return {
        reply: '{}',
        caller: { kind: CorePartyKind.jobRun, id: 'test-run' },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        revocationKey: 'test-issuer',
        hostSignal: new AbortController().signal,
        async withPromotion(publish) {
          publish();
        },
      };
    },
  });
  wss.prependOnceListener('connection', (socket) => {
    auth.register(socket, { encrypted: true }, () => socket.terminate());
    accepted.resolve(socket);
  });
  const server = new ServerTransport({ websocket: wss, auth, checkBoundaryAccess });
  await server.connect();
  const peer = new WebSocket(`ws://127.0.0.1:${port}`);
  const close = async (): Promise<void> => {
    peer.terminate();
    await server.disconnect();
  };
  try {
    const ready = Promise.withResolvers<void>();
    peer.on('message', (frame) => {
      if (frame.toString() === '{"type":"subscribe-sync-complete"}') ready.resolve();
    });
    await waitForOpen(peer);
    peer.send('{}');
    await ready.promise;
    return { peer, server, native: await accepted.promise, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Place a ping after the data frames to observe their arrival at the native server.
 * @param peer - Sending peer.
 * @param messages - Frames to send before the barrier.
 */
async function sendBeforePong(peer: WebSocket, ...messages: BusMessage[]): Promise<void> {
  const pong = once(peer, 'pong');
  for (const message of messages) peer.send(JSON.stringify(message));
  peer.ping();
  await pong;
}

it.each([true, false])('orders two frames while the first owner check is pending (%s)', async (allowed) => {
  const decision = Promise.withResolvers<boolean>();
  const entered = Promise.withResolvers<void>();
  let checks = 0;
  const { peer, server, close } = await connectOrderedPeer(async () => {
    if (++checks !== 1) return true;
    entered.resolve();
    return decision.promise;
  });
  const seen: string[] = [];
  const second = Promise.withResolvers<void>();
  server.onReceive(async (message) => {
    if (message.type !== 'event') return;
    seen.push(message.messageId);
    if (message.messageId === 'B') second.resolve();
  });
  try {
    const closed = once(peer, 'close');
    await sendBeforePong(peer, { ...eventProbe, messageId: 'A' }, { ...eventProbe, messageId: 'B' });
    await entered.promise;
    expect(checks).toBe(1);
    expect(seen).toEqual([]);
    decision.resolve(allowed);
    if (allowed) {
      await second.promise;
      expect(seen).toEqual(['A', 'B']);
    } else {
      await expect(closed).resolves.toEqual([1008, expect.any(Buffer)]);
      expect(server.getConnectionCount()).toBe(0);
      expect(checks).toBe(1);
      expect(seen).toEqual([]);
    }
  } finally {
    decision.resolve(false);
    await close();
  }
});

it('hands off an event before accepting the response that releases its handler', async () => {
  const decision = Promise.withResolvers<boolean>();
  let hold = false;
  const { peer, server, close } = await connectOrderedPeer(async () => (hold ? decision.promise : true));
  const observed: string[] = [];
  const finished = Promise.withResolvers<void>();
  try {
    const pending = await pendingWorkerResponse(server, peer);
    server.onReceive(async (message) => {
      if (message.type !== 'event') return;
      observed.push('event');
      await pending.result;
      finished.resolve();
    });
    const response = pending.result.then(() => observed.push('response'));
    hold = true;
    await sendBeforePong(peer, eventProbe, { ...pending.reply, type: 'response' });
    expect(observed).toEqual([]);
    decision.resolve(true);
    await expect(pending.result).resolves.toBe('worker response');
    await finished.promise;
    await response;
    expect(observed).toEqual(['event', 'response']);
  } finally {
    decision.resolve(false);
    await close();
  }
});

it('hands off B while the event handler for A is still running', async () => {
  const { peer, server, close } = await connectOrderedPeer(async () => true);
  const release = Promise.withResolvers<void>();
  const second = Promise.withResolvers<string[]>();
  const seen: string[] = [];
  server.onReceive(async (message) => {
    if (message.type !== 'event') return;
    seen.push(message.messageId);
    if (message.messageId === 'A') {
      await release.promise;
      seen.push('A finished');
    } else {
      second.resolve([...seen]);
    }
  });
  try {
    await sendBeforePong(peer, { ...eventProbe, messageId: 'A' }, { ...eventProbe, messageId: 'B' });
    await expect(second.promise).resolves.toEqual(['A', 'B']);
  } finally {
    release.resolve();
    await close();
  }
});

it('starts unprotected event authorization in the socket message turn', async () => {
  const order: string[] = [];
  const { peer, server, native, close } = await connectOrderedPeer(undefined, async (target) => {
    if (target.operation === 'send') order.push(`authorize ${target.subject}`);
  });
  const second = Promise.withResolvers<void>();
  const delivered: string[] = [];
  native.on('message', () => order.push('native'));
  server.onReceive(async (message) => {
    if (message.type !== 'event') return;
    delivered.push(message.messageId);
    if (message.messageId === 'B') second.resolve();
  });
  try {
    await sendBeforePong(
      peer,
      { ...eventProbe, subject: 'first', messageId: 'A' },
      { ...eventProbe, subject: 'second', messageId: 'B' },
    );
    await second.promise;
    expect(order).toEqual(['authorize first', 'native', 'authorize second', 'native']);
    expect(delivered).toEqual(['A', 'B']);
  } finally {
    await close();
  }
});

it('retires a protected session when the owner verifier throws synchronously', async () => {
  const { peer, server, close } = await connectOrderedPeer(() => {
    throw new Error('Synchronous owner check failure');
  });
  const seen: BusMessage[] = [];
  server.onReceive(async (message) => {
    seen.push(message);
  });
  try {
    const closed = once(peer, 'close');
    peer.send(JSON.stringify(eventProbe));
    await expect(closed).resolves.toEqual([1008, expect.any(Buffer)]);
    expect(seen).toEqual([]);
    expect(server.getConnectionCount()).toBe(0);
  } finally {
    await close();
  }
});

it('bounds queued application bytes by the configured exchange limit', async () => {
  const decision = Promise.withResolvers<boolean>();
  const entered = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  let checks = 0;
  const { peer, server, close } = await connectOrderedPeer(async () => {
    if (++checks === 1) return true;
    entered.resolve();
    return decision.promise;
  });
  const seen: BusMessage[] = [];
  server.onReceive(async (message) => {
    seen.push(message);
    delivered.resolve();
  });
  try {
    // One application frame can exceed the subscription cap. Two of these
    // frames awaiting handoff exceed this connection's configured exchange cap.
    const frame = JSON.stringify({ ...eventProbe, payload: 'x'.repeat(600 * 1024) });
    const closed = once(peer, 'close');
    peer.send(frame);
    await delivered.promise;
    peer.send(frame);
    await entered.promise;
    peer.send(frame);
    await expect(closed).resolves.toEqual([1008, expect.any(Buffer)]);
    decision.resolve(true);
    expect(seen).toHaveLength(1);
    expect(server.getConnectionCount()).toBe(0);
  } finally {
    decision.resolve(false);
    await close();
  }
});

it('hands off subscriptions and events in one order and retires after a failed publication', async () => {
  const { peer, server, close } = await connectOrderedPeer(async () => true);
  const publish = Promise.withResolvers<void>();
  const event = Promise.withResolvers<void>();
  const seen: string[] = [];
  server.onReceive(async (message) => {
    if (message.type === 'subscribe') {
      seen.push('subscribe');
      await publish.promise;
      throw new Error('Subscription publication failed');
    }
    if (message.type === 'event') {
      seen.push('event');
      event.resolve();
    }
  });
  try {
    const closed = once(peer, 'close');
    await sendBeforePong(peer, subscriptionProbe, eventProbe);
    await event.promise;
    expect(seen).toEqual(['subscribe', 'event']);
    publish.resolve();
    await expect(closed).resolves.toEqual([1008, expect.any(Buffer)]);
    expect(server.getConnectionCount()).toBe(0);
  } finally {
    publish.resolve();
    await close();
  }
});
