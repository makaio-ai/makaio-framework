import {
  type BoundaryAccessCheck,
  type BusBroadcastMessage,
  type BusEventMessage,
  type BusMessage,
  type BusRequestMessage,
} from '@makaio/bus-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HmacAuth } from '../auth/hmac-auth.js';
import {
  type HmacIdentitySecretRegistrationOptions,
  registerHmacIdentitySecret,
  resolveHmacIdentityParty,
  resolveHmacIdentitySecret,
} from '../auth/identity-secret-registry.js';
import { ServerTransport } from '../server-transport.js';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createTestServer } from './test-utils.js';

const namespace = 'test';
const subject = 'updates';
const pattern = `${namespace}.${subject}`;
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
   * @returns Connected transports and the initial registration's revocation callback.
   */
  async function connect(checkBoundaryAccess: BoundaryAccessCheck) {
    const revoke = registerPeer({ claims: { access: 'reader' } });
    const { wss, port } = await createTestServer();
    const server = new ServerTransport({
      websocket: wss,
      auth: new HmacAuth({ secret, resolveSecret: resolveHmacIdentitySecret, resolveParty: resolveHmacIdentityParty }),
      checkBoundaryAccess,
    });
    cleanups.push(() => server.disconnect());
    await server.connect();

    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      auth: new HmacAuth({ secret, identityId }),
      autoReconnect: false,
    });
    cleanups.push(() => client.disconnect());
    await client.connect();
    await client.ready;
    return { server, client, revoke };
  }

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
