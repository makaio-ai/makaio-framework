import { createServer } from 'node:http';
import { createBusInstance } from '@makaio/bus-core';
import { HOST_NAMESPACE_HOLDER, leaseNamespace } from '@makaio/bus-core/kernel-api';
import { ServerTransport, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { AccessDeniedError, CoreDenialPlace } from '@makaio/contracts/access';
import { SUBJECT_SEND_RIGHT, SUBJECT_SUBSCRIBE_RIGHT, type RightAnswer } from '@makaio/contracts/rights';
import { createBusNamespace, localSubject } from '@makaio/core';
import { createCoordinatorRights } from '@makaio/kernel';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WebSocketServer } from 'ws';
import { BusServerTransportProvider } from '../bus-server-transport.js';
import { closeHttpServer, listenOnLoopback } from './http-test-helpers.js';

describe('WebSocket boundary admission', () => {
  it('rejects a pending request grant after the host closes admission', async () => {
    const server = createServer();
    const bus = createBusInstance();
    const namespace = createBusNamespace('boundary-test', {
      query: { request: z.object({}), response: z.object({ handled: z.boolean() }) },
    });
    leaseNamespace(bus, namespace, HOST_NAMESPACE_HOLDER);
    const handler = vi.fn();
    bus.on(namespace.subjects.query, ({ setResult }) => {
      handler();
      setResult({ handled: true });
    });
    const rights = createCoordinatorRights(bus, 'host');
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<RightAnswer>();
    rights.activate('test-policy', {
      rightsSources: [
        {
          source: 'test-policy.boundary',
          description: 'Authorize requests when the test releases the pending answer.',
          rights: [SUBJECT_SEND_RIGHT],
          answer: () => {
            started.resolve();
            return answer.promise;
          },
        },
      ],
    });
    rights.openBoundary();

    const port = await listenOnLoopback(server);
    const transport = new BusServerTransportProvider({ httpServer: server });
    const client = new WebSocketClientTransport({ url: `ws://127.0.0.1:${port}/bus`, autoReconnect: false });
    try {
      await transport.connect(bus, {
        machineId: 'machine-integration',
        checkBoundaryAccess: rights.checkBoundaryAccess,
      });
      await client.connect();
      await client.ready;
      const outcome = client
        .send({
          type: 'request',
          namespace: namespace.name,
          subject: 'query',
          messageId: 'query',
          correlationId: 'query',
          payload: {},
          timeout: 2_000,
        })
        .catch((error: unknown) => error);
      await started.promise;
      rights.closeBoundary();
      answer.resolve({ granted: true });

      const denial = await outcome;
      expect(denial).toBeInstanceOf(AccessDeniedError);
      expect(denial).toMatchObject({ data: { at: CoreDenialPlace.send, reason: 'host-not-ready' } });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      await client.disconnect();
      await transport.disconnect();
      await closeHttpServer(server);
    }
  });

  it('delivers nothing after a deferred pattern resolves to a local-only subject', async () => {
    const httpServer = createServer();
    const bus = createBusInstance();
    const namespace = createBusNamespace('boundary-local', { hidden: localSubject(z.object({})) });
    const visible = createBusNamespace('boundary-visible', { update: z.object({}) });
    leaseNamespace(bus, visible, HOST_NAMESPACE_HOLDER);
    const rights = createCoordinatorRights(bus, 'host');
    rights.activate('test-policy', {
      rightsSources: [
        {
          source: 'test-policy.subscribe',
          description: 'Grant subscriptions on externally visible subjects.',
          rights: [SUBJECT_SUBSCRIBE_RIGHT],
          answer: async () => ({ granted: true }),
        },
      ],
    });
    rights.openBoundary();
    const check = rights.checkBoundaryAccess;
    let retry: (() => Promise<void>) | undefined;
    check.watchSubscriptionAvailability = (callback) => {
      retry = callback;
      return () => {
        retry = undefined;
      };
    };

    const port = await listenOnLoopback(httpServer);
    const server = new ServerTransport({
      websocket: new WebSocketServer({ server: httpServer }),
      checkBoundaryAccess: check,
    });
    const client = new WebSocketClientTransport({ url: `ws://127.0.0.1:${port}/bus`, autoReconnect: false });
    const event = {
      type: 'event',
      namespace: visible.name,
      subject: 'update',
      messageId: 'visible',
      payload: {},
    } as const;
    try {
      await server.connect();
      await client.connect();
      await client.ready;
      await client.subscribe(`${namespace.name}.*`);
      await expect(server.send(event)).resolves.toBe(false);
      leaseNamespace(bus, namespace, HOST_NAMESPACE_HOLDER);
      await retry?.();
      await expect(server.send(event)).resolves.toBe(false);
    } finally {
      await client.disconnect();
      await server.disconnect();
      await closeHttpServer(httpServer);
    }
  });
});
