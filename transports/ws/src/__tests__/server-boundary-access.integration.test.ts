import {
  createBusInstance,
  type BoundaryAccessCheck,
  type BusBroadcastMessage,
  type BusEventMessage,
  type BusMessage,
  type BusRequestMessage,
  type BusSubscriptionAckMessage,
  SUBSCRIPTION_DEFERRED,
} from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HmacAuth } from '../auth/hmac-auth.js';
import {
  type HmacIdentitySecretRegistrationOptions,
  registerHmacIdentitySecret,
  resolveHmacIdentityParty,
  resolveHmacIdentitySecret,
} from '../auth/identity-secret-registry.js';
import { ClientRegistry } from '../client-registry.js';
import { ServerTransport } from '../server-transport.js';
import type { ClientTransportCodec } from '../types.js';
import { DEFAULT_CODEC } from '../ws-client-options.js';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createTestServer } from './test-utils.js';

const namespace = 'test';
const subject = 'updates';
const pattern = `${namespace}.${subject}`;
const replayMarker = 'test.marker';
const identityId = 'live-policy-peer';
const secret = 'test-identity-secret';
const partyKind = 'test.peer';
const payload = { role: 'reader' };

describe('WebSocket boundary live authorization', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  /**
   * Replace the registration while retaining the socket's credential.
   * @param options - Live peer claims and restrictions.
   * @returns Cleanup for this registration.
   */
  function registerPeer(options?: Omit<HmacIdentitySecretRegistrationOptions, 'partyKind'>): () => void {
    const remove = registerHmacIdentitySecret(identityId, secret, { partyKind, ...options });
    cleanups.push(remove);
    return remove;
  }

  /**
   * Connect a real identity-authenticated client to the boundary policy.
   * @param checkBoundaryAccess - Policy exercised by this scenario.
   * @param messageTransform - Optional observer for inbound client frames.
   * @param codec - Optional codec for controlling wire order.
   * @returns Connected transports, peer creation, and the initial registration's revocation callback.
   */
  async function connect(
    checkBoundaryAccess: BoundaryAccessCheck,
    messageTransform?: ConstructorParameters<typeof WebSocketClientTransport>[0]['messageTransform'],
    codec?: ClientTransportCodec,
  ) {
    const revoke = registerPeer({ claims: { access: 'reader' } });
    const { wss, port } = await createTestServer();
    const server = new ServerTransport({
      websocket: wss,
      auth: new HmacAuth({ secret, resolveSecret: resolveHmacIdentitySecret, resolveParty: resolveHmacIdentityParty }),
      checkBoundaryAccess,
    });
    cleanups.push(() => server.disconnect());
    await server.connect();

    /** @returns Another authenticated connection to the same server. */
    async function openPeer() {
      const client = new WebSocketClientTransport({
        url: `ws://127.0.0.1:${port}`,
        auth: new HmacAuth({ secret, identityId }),
        autoReconnect: false,
        messageTransform,
        codec,
      });
      cleanups.push(() => client.disconnect());
      await client.connect();
      await client.ready;
      return client;
    }
    return { server, client: await openPeer(), wss, openPeer, revoke };
  }

  /**
   * Record the subscription patterns sent on the replacement socket.
   * @param client - Connected client to reconnect.
   * @param wss - Server accepting the replacement connection.
   * @param observe - Optional observer for the advertised subject priorities.
   * @returns Advertised patterns, including the marker.
   */
  async function reconnectAndReadAdvertisements(
    client: WebSocketClientTransport,
    wss: Awaited<ReturnType<typeof createTestServer>>['wss'],
    observe?: (subjects: Record<string, number[]>) => void,
  ): Promise<string[]> {
    const advertised: string[] = [];
    wss.once('connection', (socket) => {
      socket.on('message', (frame) => {
        const message = JSON.parse(String(frame));
        if (message.type === 'subscribe') {
          advertised.push(...Object.keys(message.subjects));
          observe?.(message.subjects);
        }
      });
    });
    await client.reconnect();
    await client.subscribe(replayMarker);
    return advertised;
  }

  it('delivers nothing while every advertised subscription is deferred', async () => {
    let available = false;
    let retry: (() => Promise<void>) | undefined;
    const check: BoundaryAccessCheck = async (target) => {
      if (target.operation === 'subscribe' && target.pattern === pattern && !available) return SUBSCRIPTION_DEFERRED;
    };
    check.watchSubscriptionAvailability = (callback) => {
      retry = callback;
      return () => {
        retry = undefined;
      };
    };
    const { server, client } = await connect(check);
    const event: BusEventMessage = { type: 'event', namespace, subject: 'other', messageId: 'unrelated', payload };

    await expect(server.send(event)).resolves.toBe(false);
    await client.subscribe(pattern);
    await expect(server.send(event)).resolves.toBe(false);
    await expect(server.send({ ...event, subject })).resolves.toBe(false);

    available = true;
    await retry?.();
    await expect(server.send({ ...event, subject })).resolves.toBe(true);
    await expect(server.send(event)).resolves.toBe(false);

    await client.unsubscribe(pattern);
    await expect(server.send(event)).resolves.toBe(false);
  });

  it.each(['replay', 'first advertisement'] as const)('delivers nothing after denying the %s', async (scenario) => {
    let replaying = false;
    let retry: (() => Promise<void>) | undefined;
    const denial = new Error('Subscription denied');
    const check: BoundaryAccessCheck = async (target) => {
      if (target.operation !== 'subscribe' || target.pattern !== pattern) return;
      if (scenario === 'replay' && !replaying) return SUBSCRIPTION_DEFERRED;
      return denial;
    };
    check.watchSubscriptionAvailability = (callback) => {
      retry = callback;
      return () => {
        retry = undefined;
      };
    };
    const { server, client } = await connect(check);
    if (scenario === 'replay') {
      await client.subscribe(pattern);
      replaying = true;
      await retry?.();
    } else {
      await expect(client.subscribe(pattern)).rejects.toThrow(denial.message);
    }
    const event: BusEventMessage = { type: 'event', namespace, subject: 'other', messageId: 'unrelated', payload };
    await expect(server.send(event)).resolves.toBe(false);
  });

  it('delivers a connection-scoped emit to an unsubscribed client under boundary policy', async () => {
    const connection = Promise.withResolvers<string>();
    const check = vi.fn<BoundaryAccessCheck>(async (target, _call, context) => {
      if (target.operation === 'send' && context?.connectionId !== undefined) {
        connection.resolve(context.connectionId);
      }
      return undefined;
    });
    const { server, client } = await connect(check);
    const bus = createBusInstance({ transports: [server] });
    const { subjects } = bus.registerNamespace(
      createBusNamespace(namespace, { updates: z.object({ role: z.string() }) }),
    );
    const event: BusEventMessage = { type: 'event', namespace, subject, messageId: 'identify-connection', payload };
    const received = vi.fn();
    client.onReceive(received);

    await client.send(event);
    const connectionId = await connection.promise;
    await expect(server.send({ ...event, messageId: 'fan-out' })).resolves.toBe(false);
    await bus.emit(subjects.updates, payload, { connectionId, messageId: 'targeted' });

    await vi.waitFor(() => expect(received.mock.lastCall?.[0]).toMatchObject({ messageId: 'targeted', payload }));
    expect(received).toHaveBeenCalledTimes(1);
    expect(client.getSubscriptions()).toEqual(new Set());
    expect(check.mock.calls.map(([target]) => target.operation)).toEqual(['send', 'deliver']);
  });

  it('delivers across namespaces when the client subscribes to the global wildcard', async () => {
    const { server, client } = await connect(async () => undefined);
    const received: string[] = [];
    client.onReceive(async (message) => {
      if (message.type === 'event') received.push(message.messageId);
    });
    await client.subscribe('*');
    const event: BusEventMessage = { type: 'event', namespace, subject, messageId: 'first', payload };
    await expect(server.send(event)).resolves.toBe(true);
    await expect(server.send({ ...event, namespace: 'other', messageId: 'second' })).resolves.toBe(true);
    await vi.waitFor(() => expect(received).toEqual(['first', 'second']));
  });

  it.each([
    'peer-changed',
    'subscription-dispatch-failed',
  ] as const)('restores admitted and deferred subscriptions after %s', async (reason) => {
    const demoted = 'test.demoted';
    const waiting = 'test.waiting';
    const added = 'test.added';
    let replacing = false;
    let mayReplay = false;
    let retry: (() => Promise<void>) | undefined;
    const check: BoundaryAccessCheck = async (target) => {
      if (target.operation !== 'subscribe') return;
      if ((target.pattern === waiting && !replacing && !mayReplay) || (target.pattern === demoted && replacing)) {
        return SUBSCRIPTION_DEFERRED;
      }
    };
    check.watchSubscriptionAvailability = (callback) => {
      retry = callback;
      return () => {
        retry = undefined;
      };
    };
    const acknowledgements: BusSubscriptionAckMessage[] = [];
    const { server, client } = await connect(check, async (message) => {
      if (message.type === 'subscription-ack' && message.ackId === 'replacement') acknowledgements.push(message);
      return message;
    });
    await client.subscribe(pattern, payload);
    await client.subscribe(demoted);
    await client.subscribe(waiting);
    server.onReceive(async (message) => {
      if (message.type !== 'subscribe' || !(added in message.subjects)) return;
      if (reason === 'peer-changed') registerPeer({ claims: { access: 'changed' } });
      else throw new Error('Subscription dispatch failed');
    });

    replacing = true;
    await client.send({
      type: 'subscribe',
      ackId: 'replacement',
      subjects: { [pattern]: [], [waiting]: [], [demoted]: [], [added]: [] },
      deliveryClasses: {},
      filters: { [pattern]: { role: 'writer' } },
    });
    await vi.waitFor(() => {
      expect(acknowledgements).toMatchObject([{ error: { code: 'forbidden', data: { data: { reason } } } }]);
    });
    replacing = false;
    /**
     * Send an event using the current routing state.
     * @param subject - Event subject within the test namespace.
     * @param body - Payload used for subscription filtering.
     * @returns Whether the socket received the event.
     */
    const deliver = (subject: string, body = payload) =>
      server.send({ type: 'event', namespace, subject, messageId: subject, payload: body });
    await expect(deliver(subject)).resolves.toBe(true);
    await expect(deliver(subject, { role: 'writer' })).resolves.toBe(false);
    await expect(deliver('demoted')).resolves.toBe(true);
    await expect(deliver('waiting')).resolves.toBe(false);
    await expect(deliver('added')).resolves.toBe(false);

    mayReplay = true;
    await retry?.();
    await expect(deliver('waiting')).resolves.toBe(true);
    expect(acknowledgements).toHaveLength(1);
  });

  it.each([
    'admission',
    'registry',
  ] as const)('acknowledges a thrown %s update once and restores routing', async (failure) => {
    const added = 'test.added';
    const ackId = 'throwing-subscribe';
    const acknowledgements: BusSubscriptionAckMessage[] = [];
    const { server, client } = await connect(
      async (target) => {
        if (failure === 'admission' && target.operation === 'subscribe' && target.pattern === added) {
          throw new Error('Admission failed');
        }
      },
      async (message) => {
        if (message.type === 'subscription-ack' && message.ackId === ackId) acknowledgements.push(message);
        return message;
      },
    );
    await client.subscribe(pattern, payload);
    const apply = ClientRegistry.prototype.handleSubscribeMessage;
    const fault =
      failure === 'registry'
        ? vi.spyOn(ClientRegistry.prototype, 'handleSubscribeMessage').mockImplementationOnce(function (
            this: ClientRegistry,
            ...args
          ) {
            apply.call(this, ...args);
            throw new Error('Registry update failed after applying subscriptions');
          })
        : undefined;
    try {
      await client.send({
        type: 'subscribe',
        ackId,
        subjects: { [pattern]: [], [added]: [] },
        deliveryClasses: {},
        filters: { [pattern]: { role: 'writer' } },
      });
      await client.subscribe('test.marker');
      expect(acknowledgements).toMatchObject([
        { ackId, error: { code: 'forbidden', data: { data: { reason: 'subscription-dispatch-failed' } } } },
      ]);
      const event: BusEventMessage = { type: 'event', namespace, subject, messageId: 'restored', payload };
      await expect(server.send(event)).resolves.toBe(true);
      await expect(server.send({ ...event, payload: { role: 'writer' } })).resolves.toBe(false);
      await expect(server.send({ ...event, subject: 'added' })).resolves.toBe(false);
    } finally {
      fault?.mockRestore();
    }
  });

  it('retains a second client route registered while rollback handlers are settling', async () => {
    const { server, client, openPeer } = await connect(async () => undefined);
    const peer = await openPeer();
    await client.subscribe(pattern);

    const added = 'test.added';
    const rollbackStarted = Promise.withResolvers<void>();
    const finishRollback = Promise.withResolvers<void>();
    const advertisements: string[] = [];
    server.onReceive(async (message) => {
      if (message.type !== 'subscribe' && message.type !== 'unsubscribe') return;
      if (added in message.subjects) advertisements.push(message.type);
      if (message.type !== 'subscribe' || !(pattern in message.subjects)) return;
      if (added in message.subjects) throw new Error('Subscription dispatch failed');
      rollbackStarted.resolve();
      await finishRollback.promise;
    });

    await client.send({
      type: 'subscribe',
      ackId: 'mixed-rollback',
      subjects: { [pattern]: [], [added]: [] },
      deliveryClasses: {},
    });
    try {
      await rollbackStarted.promise;
      await peer.subscribe(added, undefined, [100]);
    } finally {
      finishRollback.resolve();
    }
    await client.subscribe('test.marker');
    expect(advertisements).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
  });

  it('restores the subscription and acknowledges a failed unsubscribe', async () => {
    const acknowledgements: BusSubscriptionAckMessage[] = [];
    const { server, client } = await connect(
      async () => undefined,
      async (message) => {
        if (message.type === 'subscription-ack') acknowledgements.push(message);
        return message;
      },
    );
    await client.subscribe(pattern);
    acknowledgements.length = 0;
    server.onReceive(async (message) => {
      if (message.type === 'unsubscribe' && pattern in message.subjects) throw new Error('Unsubscribe dispatch failed');
    });

    await expect(client.unsubscribe(pattern)).rejects.toMatchObject({
      code: 'forbidden',
      data: { reason: 'subscription-dispatch-failed' },
    });
    expect(acknowledgements).toMatchObject([
      {
        ackId: expect.any(String),
        error: { code: 'forbidden', data: { data: { reason: 'subscription-dispatch-failed' } } },
      },
    ]);
    expect(client.getSubscriptions()).toEqual(new Set([pattern]));
    const event: BusEventMessage = { type: 'event', namespace, subject, messageId: 'restored', payload };
    await expect(server.send(event)).resolves.toBe(true);
    await expect(server.send({ ...event, subject: 'other' })).resolves.toBe(false);
    expect(acknowledgements).toHaveLength(1);
  });

  it.each([
    undefined,
    [10],
  ])('replays the confirmed priorities after an overlapping unsubscribe fails (previous priorities %j)', async (previousPriorities) => {
    const { server, client, wss } = await connect(async () => undefined);
    if (previousPriorities !== undefined) await client.subscribe(pattern, undefined, previousPriorities);

    const subscribeStarted = Promise.withResolvers<void>();
    const finishSubscribe = Promise.withResolvers<void>();
    const serverPriorities: number[][] = [];
    server.onReceive(async (message) => {
      if (message.type === 'subscribe' && pattern in message.subjects) {
        serverPriorities.push(message.subjects[pattern]!);
        subscribeStarted.resolve();
        await finishSubscribe.promise;
      }
      if (message.type === 'unsubscribe' && pattern in message.subjects) {
        throw new Error('Unsubscribe dispatch failed');
      }
    });

    const priorities = [20, 5];
    const subscribe = client.subscribe(pattern, undefined, priorities);
    await subscribeStarted.promise;
    const unsubscribe = expect(client.unsubscribe(pattern)).rejects.toMatchObject({
      code: 'forbidden',
      data: { reason: 'subscription-dispatch-failed' },
    });
    finishSubscribe.resolve();
    await Promise.all([subscribe, unsubscribe]);
    expect(serverPriorities).toEqual([priorities, priorities]);
    expect(client.getSubscriptions()).toEqual(new Set([pattern]));

    await client.disconnect();
    const replayed: number[][] = [];
    const advertised = await reconnectAndReadAdvertisements(client, wss, (subjects) => {
      if (pattern in subjects) replayed.push(subjects[pattern]!);
    });
    expect(advertised).toEqual([pattern, replayMarker]);
    expect(replayed).toEqual([priorities]);
  });

  it('replays a subscribe encoded after an overlapping unsubscribe reaches the peer', async () => {
    const encodingStarted = Promise.withResolvers<void>();
    const finishEncoding = Promise.withResolvers<void>();
    const codec: ClientTransportCodec = {
      ...DEFAULT_CODEC,
      encode: async (message) => {
        if (message.type === 'subscribe' && pattern in message.subjects) {
          encodingStarted.resolve();
          await finishEncoding.promise;
        }
        return DEFAULT_CODEC.encode(message);
      },
    };
    const { server, client, wss } = await connect(async () => undefined, undefined, codec);
    const subscribe = client.subscribe(pattern);
    await encodingStarted.promise;
    try {
      await client.unsubscribe(pattern);
    } finally {
      finishEncoding.resolve();
      await subscribe;
    }

    const event: BusEventMessage = { type: 'event', namespace, subject, messageId: 'subscribed', payload };
    await expect(server.send(event)).resolves.toBe(true);
    expect(client.getSubscriptions()).toEqual(new Set([pattern]));
    await client.disconnect();
    await expect(reconnectAndReadAdvertisements(client, wss)).resolves.toEqual([pattern, replayMarker]);
  });

  it.each([
    'subscribe',
    'unsubscribe',
  ] as const)('replays the final subscription after overlapping %s, with acknowledgements in order', async (first) => {
    const { client, wss } = await connect(async () => undefined);
    if (first === 'unsubscribe') await client.subscribe(pattern);
    const firstUpdate = first === 'subscribe' ? client.subscribe(pattern) : client.unsubscribe(pattern);
    const secondUpdate = first === 'subscribe' ? client.unsubscribe(pattern) : client.subscribe(pattern);
    await Promise.all([firstUpdate, secondUpdate]);

    const expected = first === 'subscribe' ? [replayMarker] : [pattern, replayMarker];
    await client.disconnect();
    const advertised = await reconnectAndReadAdvertisements(client, wss);
    expect(advertised).toEqual(expected);
    expect(client.getSubscriptions()).toEqual(new Set(expected));
  });

  it('fences a socket revoked during request authorization before dispatch', async () => {
    const started = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<undefined>();
    const { server, client, revoke } = await connect(async ({ operation }) => {
      if (operation !== 'send') return;
      started.resolve();
      return decision.promise;
    });
    const handler = vi.fn(async (message: BusMessage) => {
      if (message.type === 'request') {
        await server.send({ type: 'response', correlationId: message.correlationId, result: 'handled' });
      }
    });
    server.onReceive(handler);
    const request: BusRequestMessage = {
      type: 'request',
      namespace,
      subject,
      payload,
      messageId: 'request',
      correlationId: 'request',
    };
    const outcome = client.send(request).catch((error: unknown) => error);
    await started.promise;
    revoke();
    decision.resolve(undefined);

    expect(await outcome).toMatchObject({ code: 'WS_POLICY_REJECTED' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    { allowedSubscriptionSubjects: ['test.other'] },
    { requiredSubscriptionFilters: { [pattern]: { role: 'admin' } } },
  ])('rechecks changed receiver restrictions after the delivery grant: %j', async (restriction) => {
    const started = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<undefined>();
    const { server, client } = await connect(async ({ operation }) => {
      if (operation !== 'deliver') return;
      started.resolve();
      return decision.promise;
    });
    await client.subscribe(pattern);
    const received = vi.fn(async () => {});
    client.onReceive(received);
    const delivery = server.send({ type: 'event', namespace, subject, messageId: 'restricted', payload });
    await started.promise;
    registerPeer({ claims: { access: 'reader' }, ...restriction });
    decision.resolve(undefined);

    await expect(delivery).resolves.toBe(false);
    expect(received).not.toHaveBeenCalled();
  });

  it('resolves claims from the live identity for later subscriptions and deliveries', async () => {
    const checks = vi.fn<BoundaryAccessCheck>().mockResolvedValue(undefined);
    const { server, client } = await connect(checks);
    await client.subscribe(pattern);
    expect(checks.mock.lastCall?.[1].caller.claims).toEqual({ access: 'reader' });

    registerPeer();
    await client.subscribe('test.other');
    expect(checks.mock.lastCall?.[0].operation).toBe('subscribe');
    expect(checks.mock.lastCall?.[1].caller.claims).toBeUndefined();
    await expect(server.send({ type: 'event', namespace, subject, messageId: 'claims', payload })).resolves.toBe(true);
    expect(checks.mock.lastCall?.[0].operation).toBe('deliver');
    expect(checks.mock.lastCall?.[1].caller.claims).toBeUndefined();
  });

  it.each(['event', 'broadcast'] as const)('filters %s recipients using the JSON payload', async (type) => {
    const checks = vi.fn<BoundaryAccessCheck>().mockResolvedValue(undefined);
    const { server, client } = await connect(checks);
    registerPeer({ claims: { access: 'reader' }, requiredSubscriptionFilters: { [pattern]: payload } });
    await client.subscribe(pattern, undefined, type === 'broadcast' ? [100] : []);
    checks.mockClear();
    client.onReceive(async (message) => {
      if (message.type === 'broadcast') {
        await client.send({
          type: 'broadcast-response',
          correlationId: message.correlationId,
          results: [{ nodeId: identityId, payload: message.payload }],
        });
      }
    });
    const message: BusEventMessage | BusBroadcastMessage = {
      type,
      namespace,
      subject,
      messageId: 'projected',
      correlationId: 'projected',
      payload: { ...payload, toJSON: () => ({ role: 'admin' }) },
    };
    await expect(server.send(message)).resolves.toEqual(type === 'event' ? false : []);
    expect(checks).not.toHaveBeenCalled();

    message.payload = { role: 'admin', toJSON: () => payload };
    const result = await server.send(message);
    expect(result).toEqual(type === 'event' ? true : [{ nodeId: identityId, payload }]);
    expect(checks.mock.lastCall?.[0]).toMatchObject({ payload });
  });
});
