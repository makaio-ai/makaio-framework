import { CorrelationTracker, type BusReceiveHandler } from '@makaio/bus-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BroadcastAggregator } from '../broadcast-aggregator.js';
import { ClientRegistry } from '../client-registry.js';
import { createInboundMessageHandler, routeMessage, type MessageHandlerDeps } from '../server-message-handler.js';
import type { TransportAuth } from '../types.js';
import { MockWebSocket } from './test-helpers.js';

function makeDeps(overrides: Partial<MessageHandlerDeps> = {}): MessageHandlerDeps {
  return {
    registry: new ClientRegistry(),
    correlations: new CorrelationTracker(),
    broadcastAggregator: new BroadcastAggregator({ timeout: 0 }),
    handlers: new Set<BusReceiveHandler>(),
    auth: undefined,
    normalizeBroadcastTimeout: () => 0,
    sendSafely: vi.fn(),
    debug: true,
    ...overrides,
  };
}

function makeAuth(overrides: Partial<TransportAuth>): TransportAuth {
  return {
    authenticateClient: vi.fn(async () => undefined),
    authenticateServer: vi.fn(async () => undefined),
    handleAuthMessage: vi.fn(() => false),
    cleanupSocket: vi.fn(),
    cleanup: vi.fn(),
    ...overrides,
  };
}

describe('createInboundMessageHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs malformed JSON as a parse failure', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createInboundMessageHandler(new MockWebSocket(), makeDeps());

    await handler('{');

    expect(errorSpy).toHaveBeenCalledWith('[ServerTransport] Failed to parse message:', expect.any(SyntaxError));
    expect(errorSpy).not.toHaveBeenCalledWith('[ServerTransport] Failed to process message:', expect.anything());
  });

  it('logs auth and routing failures as processing failures', async () => {
    const error = new Error('auth failed');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = makeAuth({
      handleAuthMessage: vi.fn(() => {
        throw error;
      }),
    });
    const handler = createInboundMessageHandler(new MockWebSocket(), makeDeps({ auth }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'message', payload: {} }));

    expect(errorSpy).toHaveBeenCalledWith('[ServerTransport] Failed to process message:', error);
    expect(errorSpy).not.toHaveBeenCalledWith('[ServerTransport] Failed to parse message:', expect.anything());
  });

  it('drops non-auth messages while the socket is authenticating', async () => {
    const socket = new MockWebSocket();
    const registry = new ClientRegistry();
    const handlers = new Set<BusReceiveHandler>();
    const handlerSpy = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    handlers.add(handlerSpy);

    // Auth that never claims the message (returns false) — simulates a non-auth frame
    // arriving while the socket is still in the authenticating state.
    const auth = makeAuth({ handleAuthMessage: vi.fn(() => false) });

    registry.addAuthenticating(socket);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const handler = createInboundMessageHandler(socket, makeDeps({ auth, registry, handlers }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'x', payload: {} }));

    // The message must NOT reach any handler — the auth gate must have dropped it.
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[ServerTransport] Ignoring message from unauthenticated client');
  });

  it('closes sockets whose authenticated session has expired before routing bus messages', async () => {
    const socket = new MockWebSocket();
    const handlers = new Set<BusReceiveHandler>();
    const handlerSpy = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    handlers.add(handlerSpy);
    const auth = makeAuth({
      handleAuthMessage: vi.fn(() => false),
      isSocketAuthenticated: vi.fn(() => false),
    });
    const closeSpy = vi.spyOn(socket, 'close');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const handler = createInboundMessageHandler(socket, makeDeps({ auth, handlers }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'x', payload: {} }));

    expect(handlerSpy).not.toHaveBeenCalled();
    expect(auth.cleanupSocket).toHaveBeenCalledWith(socket);
    expect(closeSpy).toHaveBeenCalledWith(1008, 'Authentication expired');
    expect(warnSpy).toHaveBeenCalledWith('[ServerTransport] Closing socket with expired authentication');
  });

  it('routes messages when auth has no live-socket authorization hook', async () => {
    const socket = new MockWebSocket();
    const handlers = new Set<BusReceiveHandler>();
    const handlerSpy = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    handlers.add(handlerSpy);
    const auth = makeAuth({ handleAuthMessage: vi.fn(() => false) });
    const handler = createInboundMessageHandler(socket, makeDeps({ auth, handlers }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'x', payload: {} }));

    expect(handlerSpy).toHaveBeenCalledOnce();
  });

  it('rejects malformed priority arrays before they enter aggregate state', async () => {
    const socket = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const deps = makeDeps({ handlers: new Set([handler]), debug: false });

    const inbound = createInboundMessageHandler(socket, deps);
    await inbound(
      JSON.stringify({
        type: 'subscribe',
        subjects: { 'hook.response': ['invalid'] },
        deliveryClasses: { 'hook.response': 'relayable' },
      }),
    );
    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      new MockWebSocket(),
      deps,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      undefined,
    );
  });

  it('does not acknowledge subscribe messages when a handler fails', async () => {
    const socket = new MockWebSocket();
    const sendSafely = vi.fn();
    const handlers = new Set<BusReceiveHandler>([
      async () => {
        throw new Error('subscribe handler failed');
      },
    ]);

    await routeMessage(
      {
        type: 'subscribe',
        ackId: 'subscribe-failed',
        subjects: { 'test.subject': [] },
        deliveryClasses: { 'test.subject': 'relayable' },
      },
      socket,
      makeDeps({ debug: false, handlers, sendSafely }),
    );

    expect(sendSafely).not.toHaveBeenCalledWith(
      socket,
      JSON.stringify({ type: 'subscription-ack', ackId: 'subscribe-failed' }),
    );
  });

  it('does not acknowledge unsubscribe messages when a handler fails', async () => {
    const socket = new MockWebSocket();
    const sendSafely = vi.fn();
    const handlers = new Set<BusReceiveHandler>([
      async () => {
        throw new Error('unsubscribe handler failed');
      },
    ]);

    await routeMessage(
      {
        type: 'unsubscribe',
        ackId: 'unsubscribe-failed',
        subjects: { 'test.subject': [] },
      },
      socket,
      makeDeps({ debug: false, handlers, sendSafely }),
    );

    expect(sendSafely).not.toHaveBeenCalledWith(
      socket,
      JSON.stringify({ type: 'subscription-ack', ackId: 'unsubscribe-failed' }),
    );
  });

  it('aggregates priorities and lets first-hop-only win across clients', async () => {
    const clientA = new MockWebSocket();
    const clientB = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const deps = makeDeps({ handlers: new Set([handler]) });

    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      clientA,
      deps,
    );
    await routeMessage(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [200] },
        deliveryClasses: { 'hook.response': 'first-hop-only' },
      },
      clientB,
      deps,
    );

    expect(handler).toHaveBeenLastCalledWith(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [200, 100] },
        deliveryClasses: { 'hook.response': 'first-hop-only' },
      },
      undefined,
    );
  });

  it('retains the aggregate subscription until the final client unsubscribes', async () => {
    const clientA = new MockWebSocket();
    const clientB = new MockWebSocket();
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const deps = makeDeps({ handlers: new Set([handler]) });

    for (const client of [clientA, clientB]) {
      await routeMessage(
        {
          type: 'subscribe',
          subjects: { 'hook.response': client === clientA ? [100] : [200] },
          deliveryClasses: { 'hook.response': client === clientA ? 'relayable' : 'first-hop-only' },
        },
        client,
        deps,
      );
    }

    handler.mockClear();
    await routeMessage({ type: 'unsubscribe', subjects: { 'hook.response': [200] } }, clientB, deps);
    expect(handler).toHaveBeenLastCalledWith(
      {
        type: 'subscribe',
        subjects: { 'hook.response': [100] },
        deliveryClasses: { 'hook.response': 'relayable' },
      },
      undefined,
    );

    await routeMessage({ type: 'unsubscribe', subjects: { 'hook.response': [100] } }, clientA, deps);
    expect(handler).toHaveBeenLastCalledWith({ type: 'unsubscribe', subjects: { 'hook.response': [] } }, undefined);
  });
});
