import { CorrelationTracker, type BusReceiveHandler, type BusRequestMessage } from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';
import { describe, expect, it, vi } from 'vitest';
import { BroadcastAggregator } from '../broadcast-aggregator.js';
import { ClientRegistry } from '../client-registry.js';
import { routeMessage } from '../server-message-handler.js';
import type { TransportAuth } from '../types.js';
import { MockWebSocket } from './test-helpers.js';

describe('ServerTransport receive context', () => {
  it('passes auth-derived socket context to registered bus receive handlers', async () => {
    const socket = new MockWebSocket();
    const receiveContext: TransportReceiveContext = {
      transportName: 'websocket',
      connectionId: 'ws-conn-1',
      peer: { kind: 'browser', id: 'browser-1', authenticated: true, encrypted: true },
      principal: { kind: 'user', id: 'user-1' },
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

    expect(handler).toHaveBeenCalledWith(message, receiveContext);
  });
});
