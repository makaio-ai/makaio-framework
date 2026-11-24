import { CorrelationTracker, type BusReceiveHandler, type BusRequestMessage } from '@makaio/bus-core';
import { MAKAIO_E2E_PEER_PARTY_KIND, type TransportReceiveContext } from '@makaio/core';
import { describe, expect, it, vi } from 'vitest';
import { DispatchingAuth } from '../auth/dispatching-auth.js';
import { HmacAuth } from '../auth/hmac-auth.js';
import { registerHmacIdentitySecret, resolveHmacIdentitySecret } from '../auth/identity-secret-registry.js';
import { BroadcastAggregator } from '../broadcast-aggregator.js';
import { ClientRegistry } from '../client-registry.js';
import { routeMessage, type MessageHandlerDeps } from '../server-message-handler.js';
import type { TransportAuth } from '../types.js';
import { MockWebSocket } from './test-helpers.js';

describe('ServerTransport receive context', () => {
  it('passes auth-derived socket context to registered bus receive handlers', async () => {
    const socket = new MockWebSocket();
    const receiveContext: TransportReceiveContext = {
      transportName: 'websocket',
      connectionId: 'ws-conn-1',
      authenticated: true,
      encrypted: true,
      caller: { kind: MAKAIO_E2E_PEER_PARTY_KIND, id: 'browser-1' },
    };
    const auth: TransportAuth = {
      authenticateClient: vi.fn().mockResolvedValue(undefined),
      authenticateServer: vi.fn().mockResolvedValue(undefined),
      handleAuthMessage: vi.fn().mockReturnValue(false),
      cleanupSocket: vi.fn(),
      cleanup: vi.fn(),
      getReceiveContext: vi.fn().mockReturnValue(receiveContext),
    };
    const handler = vi.fn<BusReceiveHandler>().mockResolvedValue(undefined);
    const message: BusRequestMessage = {
      type: 'request',
      namespace: 'ctx',
      subject: 'read',
      payload: {},
      correlationId: 'corr-1',
      messageId: 'msg-1',
    };

    await routeMessage(message, socket, {
      registry: new ClientRegistry({ debug: false }),
      correlations: new CorrelationTracker(),
      broadcastAggregator: new BroadcastAggregator({ debug: false }),
      handlers: new Set([handler]),
      auth,
      normalizeBroadcastTimeout: () => 5000,
      sendSafely: vi.fn(),
      debug: false,
    });

    expect(handler).toHaveBeenCalledWith(expect.objectContaining(message), receiveContext);
  });

  it.each([
    { projection: 'omitted', caller: null, dispatch: false },
    {
      projection: 'remapped through DispatchingAuth',
      caller: { kind: 'test.identity', id: 'public-id' },
      dispatch: true,
    },
  ])('enforces authenticated identity restrictions when the caller is $projection', async ({ caller, dispatch }) => {
    const socket = new MockWebSocket();
    const identityId = 'restricted-hmac-identity';
    const secret = 'test-identity-secret';
    const unregister = registerHmacIdentitySecret(identityId, secret, {
      partyKind: 'test.identity',
      allowedMessageSubjects: ['ctx.allowed'],
    });
    const hmac = new HmacAuth({
      secret: 'global-secret',
      resolveSecret: resolveHmacIdentitySecret,
      resolveParty: () => caller,
    });
    const auth = dispatch ? new DispatchingAuth({ hmac }) : hmac;
    const clientAuth = new HmacAuth({ secret, identityId });
    const received: BusRequestMessage[] = [];
    const handler: BusReceiveHandler = async (message) => {
      if (message.type === 'request') received.push(message);
    };
    const deps: MessageHandlerDeps = {
      registry: new ClientRegistry({ debug: false }),
      correlations: new CorrelationTracker(),
      broadcastAggregator: new BroadcastAggregator({ debug: false }),
      handlers: new Set([handler]),
      auth,
      normalizeBroadcastTimeout: () => 5000,
      sendSafely: (client, data) => {
        client.send(data);
        return true;
      },
      debug: false,
    };
    const request: BusRequestMessage = {
      type: 'request',
      namespace: 'ctx',
      subject: 'denied',
      payload: {},
      correlationId: 'denied-correlation',
      messageId: 'denied-message',
    };

    try {
      await Promise.all([
        auth.authenticateServer(socket, (message) => clientAuth.handleAuthMessage(message)),
        clientAuth.authenticateClient((message) => auth.handleAuthMessage(message, socket)),
      ]);
      expect(auth.getReceiveContext(socket)?.caller ?? null).toEqual(caller);

      await routeMessage(request, socket, deps);

      expect(received).toEqual([]);
      expect(socket.sentMessages.map((message) => JSON.parse(message))).toContainEqual({
        type: 'response',
        correlationId: request.correlationId,
        error: { message: `Subject 'ctx.denied' is not allowed for peer '${identityId}'` },
      });
    } finally {
      auth.cleanup();
      clientAuth.cleanup();
      unregister();
    }
  });
});
