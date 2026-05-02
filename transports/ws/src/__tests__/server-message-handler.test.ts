import { CorrelationTracker, type BusReceiveHandler } from '@makaio/bus-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
