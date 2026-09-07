import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { createBusInstance } from '@makaio/bus-core';
import { HmacAuth, ServerTransport, WebSocketClientTransport } from '@makaio/bus-transport-websocket';
import { createWorkerBusAuth } from '../worker-bus-auth.js';
import { BootstrapDeadlineExceededError, runWorkerBootstrapExchange } from '../worker-bootstrap-exchange.js';

const Namespace = createBusNamespace('bootstrapExchangeTest', {
  authorize: { request: z.object({}), response: z.object({ permitted: z.boolean() }) },
});

describe('worker bootstrap exchange over real authenticated WebSockets', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups.length = 0;
  });

  /**
   * Create a real server socket and register teardown before returning it.
   * @param port - Explicit port for unavailable-then-recovered tests.
   * @returns Listening server and its URL.
   */
  async function listen(port = 0) {
    const server = new WebSocketServer({ port, host: '127.0.0.1' });
    cleanups.push(async () => {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (typeof address === 'string' || !address) throw new Error('Expected TCP address');
    return { server, port: address.port, url: `ws://127.0.0.1:${address.port}` };
  }

  /**
   * Bind an actual bus responder; the client must wait for subscription readiness.
   * @param server - Listening socket server.
   * @param secret - Optional HMAC credentials.
   * @returns Connected server bus.
   */
  async function serve(server: WebSocketServer, secret?: string) {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(Namespace);
    bus.on(subjects.authorize, (ctx) => ctx.setResult({ permitted: true }));
    bus.registerTransport(new ServerTransport({ websocket: server, auth: createWorkerBusAuth(secret) }));
    cleanups.push(() => bus.disconnect());
    await bus.connect();
    return bus;
  }

  /**
   * Synchronously own a real client bus before async connection starts.
   * @param url - Server endpoint.
   * @param secret - Optional HMAC credentials.
   * @param identityId - Optional identity carried in the HMAC handshake.
   * @returns Session with connection and request surfaces.
   */
  function clientSession(url: string, secret?: string, identityId?: string) {
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(Namespace);
    const transport = new WebSocketClientTransport({
      url,
      auth: createWorkerBusAuth(secret, identityId),
      autoReconnect: false,
      heartbeat: false,
    });
    bus.registerTransport(transport);
    cleanups.push(() => bus.disconnect());
    return { bus, transport, subjects };
  }

  it('retries a genuinely unavailable server and then executes after subscribe readiness', async () => {
    const first = await listen();
    await new Promise<void>((resolve) => first.server.close(() => resolve()));
    const sessions: ReturnType<typeof clientSession>[] = [];
    const failures: unknown[] = [];
    const result = await runWorkerBootstrapExchange({
      bootstrapDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
      signal: new AbortController().signal,
      createSession: () => {
        const session = clientSession(first.url, 'shared-secret');
        sessions.push(session);
        return session;
      },
      connect: async (session) => {
        try {
          await session.bus.connect();
        } catch (error) {
          failures.push(error);
          const recovered = await listen(first.port);
          await serve(recovered.server, 'shared-secret');
          throw error;
        }
      },
      exchange: async (session, { timeoutMs, signal }) => {
        expect(session.transport.isReady()).toBe(true);
        const response = await session.bus.request(session.subjects.authorize, {}, { timeout: timeoutMs, signal });
        return { status: 'complete', value: response.permitted };
      },
      dispose: (session) => session.bus.disconnect(),
    });
    expect(result.value).toBe(true);
    expect(sessions).toHaveLength(2);
    expect(failures).toEqual([expect.objectContaining({ code: 'WS_CONNECTION_UNAVAILABLE' })]);
    expect(sessions[0]?.transport.isReady()).toBe(false);
    expect(sessions[1]?.transport.isReady()).toBe(true);
  });

  it('stops after a real credential rejection without reconnecting', async () => {
    const { server, url } = await listen();
    await serve(server, 'correct-secret');
    const sessions: ReturnType<typeof clientSession>[] = [];
    await expect(
      runWorkerBootstrapExchange({
        bootstrapDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
        signal: new AbortController().signal,
        createSession: () => {
          const session = clientSession(url, 'wrong-secret');
          sessions.push(session);
          return session;
        },
        connect: (session) => session.bus.connect(),
        exchange: async () => ({ status: 'complete', value: true }),
        dispose: (session) => session.bus.disconnect(),
      }),
    ).rejects.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.transport.isReady()).toBe(false);
  });

  it('does not retry a peer policy close during authentication', async () => {
    const { server, url } = await listen();
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      socket.close(1008, 'policy denied');
    });
    await expect(
      runWorkerBootstrapExchange({
        bootstrapDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
        signal: new AbortController().signal,
        createSession: () => clientSession(url, 'shared-secret'),
        connect: (session) => session.bus.connect(),
        exchange: async () => ({ status: 'complete', value: true }),
        dispose: (session) => session.bus.disconnect(),
      }),
    ).rejects.toMatchObject({ code: 'WS_POLICY_REJECTED' });
    expect(connections).toBe(1);
  });

  it('does not reconnect after a policy close while an authenticated exchange is pending', async () => {
    const { server, url } = await listen();
    const bus = createBusInstance();
    const { subjects } = bus.registerNamespace(Namespace);
    let connections = 0;
    server.on('connection', () => {
      connections += 1;
    });
    bus.on(subjects.authorize, async () => {
      for (const socket of server.clients) socket.close(1008, 'policy changed');
      await new Promise<void>(() => {});
    });
    bus.registerTransport(new ServerTransport({ websocket: server, auth: createWorkerBusAuth('shared-secret') }));
    cleanups.push(() => bus.disconnect());
    await bus.connect();
    await expect(
      runWorkerBootstrapExchange({
        bootstrapDeadlineAt: new Date(Date.now() + 2200).toISOString(),
        signal: new AbortController().signal,
        createSession: () => clientSession(url, 'shared-secret'),
        connect: (session) => session.bus.connect(),
        exchange: async (session, { signal, timeoutMs }) => {
          const response = await session.bus.request(session.subjects.authorize, {}, { signal, timeout: timeoutMs });
          return { status: 'complete', value: response.permitted };
        },
        dispose: (session) => session.bus.disconnect(),
      }),
    ).rejects.toMatchObject({ code: 'WS_POLICY_REJECTED' });
    expect(connections).toBe(1);
  });

  it('authenticates the helper-created identity using its own secret, not the server-global secret', async () => {
    const { server, url } = await listen();
    const bus = createBusInstance();
    bus.registerNamespace(Namespace);
    const identities: string[] = [];
    bus.registerTransport(
      new ServerTransport({
        websocket: server,
        auth: new HmacAuth({
          secret: 'different-server-global-secret',
          resolveSecret: (identityId) => {
            identities.push(identityId);
            return identityId === 'attempt-123' ? 'attempt-secret' : null;
          },
        }),
      }),
    );
    cleanups.push(() => bus.disconnect());
    await bus.connect();
    const session = clientSession(url, 'attempt-secret', 'attempt-123');
    await session.bus.connect();
    expect(session.transport.isReady()).toBe(true);
    expect(identities).toEqual(['attempt-123']);
    expect(createWorkerBusAuth(undefined, 'attempt-123')).toBeUndefined();
  });

  it('includes subscribe readiness in the bounded connect and never starts exchange early', async () => {
    const { server, url } = await listen();
    let opened = false;
    let exchanges = 0;
    server.on('connection', () => {
      opened = true;
      // Deliberately never send subscribe-sync-complete.
    });
    const session = clientSession(url);
    await expect(
      runWorkerBootstrapExchange({
        bootstrapDeadlineAt: new Date(Date.now() + 150).toISOString(),
        signal: new AbortController().signal,
        createSession: () => session,
        connect: (owned) => owned.bus.connect(),
        exchange: async () => {
          exchanges += 1;
          return { status: 'complete', value: true };
        },
        dispose: (owned) => owned.bus.disconnect(),
      }),
    ).rejects.toBeInstanceOf(BootstrapDeadlineExceededError);
    expect(opened).toBe(true);
    expect(exchanges).toBe(0);
    expect(session.transport.isReady()).toBe(false);
  });
});
