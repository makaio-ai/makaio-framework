import { CorrelationTracker, type BusReceiveHandler } from '@makaio/bus-core';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { BroadcastAggregator } from '../broadcast-aggregator.js';
import { ClientRegistry } from '../client-registry.js';
import { createInboundMessageHandler, type MessageHandlerDeps } from '../server-message-handler.js';
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
    sendSafely: mock(() => undefined),
    debug: true,
    ...overrides,
  };
}

function makeAuth(overrides: Partial<TransportAuth>): TransportAuth {
  return {
    authenticateClient: mock(async () => undefined),
    authenticateServer: mock(async () => undefined),
    handleAuthMessage: mock(() => false),
    cleanupSocket: mock(() => undefined),
    cleanup: mock(() => undefined),
    ...overrides,
  };
}

describe('createInboundMessageHandler', () => {
  afterEach(() => {
    mock.restore();
  });

  it('logs malformed JSON as a parse failure', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = createInboundMessageHandler(new MockWebSocket(), makeDeps());

    await handler('{');

    expect(errorSpy).toHaveBeenCalledWith('[ServerTransport] Failed to parse message:', expect.any(SyntaxError));
    expect(errorSpy).not.toHaveBeenCalledWith('[ServerTransport] Failed to process message:', expect.anything());
  });

  it('logs auth and routing failures as processing failures', async () => {
    const error = new Error('auth failed');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
    const auth = makeAuth({
      handleAuthMessage: mock(() => {
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
    const handlerSpy = mock<BusReceiveHandler>(async () => undefined);
    handlers.add(handlerSpy);

    // Auth that never claims the message (returns false) — simulates a non-auth frame
    // arriving while the socket is still in the authenticating state.
    const auth = makeAuth({ handleAuthMessage: mock(() => false) });

    registry.addAuthenticating(socket);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);

    const handler = createInboundMessageHandler(socket, makeDeps({ auth, registry, handlers }));

    await handler(JSON.stringify({ type: 'event', namespace: 'test', subject: 'x', payload: {} }));

    // The message must NOT reach any handler — the auth gate must have dropped it.
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[ServerTransport] Ignoring message from unauthenticated client');
  });
});
