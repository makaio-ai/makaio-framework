/** Real-socket coverage for bootstrap failure classification and disposal. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { HmacAuth, ServerTransport, WebSocketClientTransport, WebSocketConnectionError } from '../index.js';
import { closeServer, createTestServer, waitForCondition } from './test-utils.js';

describe('WebSocket bootstrap failures with real HMAC authentication', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  /**
   * Create a real client and a peer whose authentication frames are controlled by the test.
   * @param challengeTimeout - Maximum wait for each HMAC phase.
   * @returns Client, server, and connection callback spy.
   */
  async function createPeer(challengeTimeout = 2000) {
    const { wss, port } = await createTestServer();
    cleanups.push(() => closeServer(wss));
    const onConnected = vi.fn();
    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      auth: new HmacAuth({ secret: 'bootstrap-test-secret', challengeTimeout }),
      connectTimeoutMs: 10_000,
      autoReconnect: false,
      heartbeat: false,
      onConnected,
    });
    cleanups.push(() => client.disconnect());
    return { client, wss, onConnected };
  }

  /**
   * Connect client and server using the actual HMAC verifier on both ends.
   * @param clientSecret - Secret used by the client.
   * @param options - Optional server verifier and client identity.
   * @returns Both transports and the client connection callback spy.
   */
  async function createAuthenticatedPair(
    clientSecret: string,
    options: { serverAuth?: HmacAuth; identityId?: string } = {},
  ) {
    const { wss, port } = await createTestServer();
    const server = new ServerTransport({
      websocket: wss,
      auth: options.serverAuth ?? new HmacAuth({ secret: 'bootstrap-test-secret', challengeTimeout: 2000 }),
    });
    cleanups.push(() => server.disconnect());
    await server.connect();
    const onConnected = vi.fn();
    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      auth: new HmacAuth({ secret: clientSecret, challengeTimeout: 2000, identityId: options.identityId }),
      connectTimeoutMs: 10_000,
      autoReconnect: false,
      heartbeat: false,
      onConnected,
    });
    cleanups.push(() => client.disconnect());
    return { client, server, onConnected };
  }

  it('classifies a real wrong-secret rejection as authentication rejection', async () => {
    const { client, server, onConnected } = await createAuthenticatedPair('wrong-secret');
    const startedAt = performance.now();
    const failure = await client.connect().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WebSocketConnectionError);
    const code = failure instanceof WebSocketConnectionError ? failure.code : undefined;
    expect(code, `Authentication code ${code} after ${Math.round(performance.now() - startedAt)}ms`).toBe(
      'WS_AUTHENTICATION_REJECTED',
    );
    expect(client.isReady()).toBe(false);
    expect(server.getConnectionCount()).toBe(0);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('closes a missing server-side HMAC response with 1011, not a policy rejection', async () => {
    const { wss, port } = await createTestServer();
    const server = new ServerTransport({
      websocket: wss,
      auth: new HmacAuth({ secret: 'bootstrap-test-secret', challengeTimeout: 300 }),
    });
    cleanups.push(() => server.disconnect());
    await server.connect();
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(async () => client.terminate());
    const frames: unknown[] = [];
    client.on('message', (data) => frames.push(JSON.parse(data.toString())));
    const closed = new Promise<number>((resolve, reject) => {
      client.once('close', resolve);
      client.once('error', reject);
    });

    expect(await closed).toBe(1011);
    expect(frames).toEqual([expect.objectContaining({ type: 'auth-challenge' })]);
    expect(server.getConnectionCount()).toBe(0);
  });

  it('does not turn an unexpected server secret-resolver failure into credential rejection', async () => {
    const { client, server, onConnected } = await createAuthenticatedPair('bootstrap-test-secret', {
      identityId: 'bootstrap-test-client',
      serverAuth: new HmacAuth({
        secret: 'bootstrap-test-secret',
        resolveSecret: () => {
          throw new Error('Secret store unavailable');
        },
      }),
    });

    await expect(client.connect()).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    expect(client.isReady()).toBe(false);
    expect(server.getConnectionCount()).toBe(0);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it.each(['challenge', 'result'])('classifies a missing HMAC %s as handshake timeout', async (phase) => {
    const { client, wss, onConnected } = await createPeer(300);
    let receivedResponse = false;
    if (phase === 'result') {
      wss.on('connection', (socket) => {
        socket.on('message', () => {
          receivedResponse = true;
        });
        socket.send(JSON.stringify({ type: 'auth-challenge', nonce: 'stalled-result' }));
      });
    }

    await expect(client.connect()).rejects.toMatchObject({ code: 'WS_HANDSHAKE_TIMEOUT' });
    expect(receivedResponse).toBe(phase === 'result');
    await waitForCondition(() => wss.clients.size === 0, 1000, 'timed-out client socket was not disposed');
    expect(client.isReady()).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it.each([
    [1000, 'WS_CONNECTION_UNAVAILABLE'],
    [1008, 'WS_POLICY_REJECTED'],
  ] as const)('classifies peer close %i while awaiting the HMAC result', async (closeCode, expectedCode) => {
    const { client, wss, onConnected } = await createPeer();
    wss.on('connection', (socket) => {
      socket.once('message', () => socket.close(closeCode, 'test peer closed authentication'));
      socket.send(JSON.stringify({ type: 'auth-challenge', nonce: 'close-after-response' }));
    });

    await expect(client.connect()).rejects.toMatchObject({ code: expectedCode });
    await waitForCondition(() => wss.clients.size === 0);
    expect(client.isReady()).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('disconnect settles a pending HMAC result without reviving readiness', { timeout: 2000 }, async () => {
    const { client, wss, onConnected } = await createPeer(10_000);
    const responseReceived = new Promise<WebSocket>((resolve) => {
      wss.on('connection', (socket) => {
        socket.once('message', () => resolve(socket));
        socket.send(JSON.stringify({ type: 'auth-challenge', nonce: 'disconnect-after-response' }));
      });
    });
    const failure = client.connect().catch((error: unknown) => error);
    const peer = await responseReceived;

    const disconnected = client.disconnect();
    // A result already in flight must not resurrect the cancelled connection.
    peer.send(JSON.stringify({ type: 'auth-result', success: true }));
    await disconnected;
    expect(await failure).toBeInstanceOf(Error);
    await waitForCondition(() => wss.clients.size === 0);
    expect(client.isReady()).toBe(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it('still authenticates and becomes ready with a matching secret', async () => {
    const { client, server, onConnected } = await createAuthenticatedPair('bootstrap-test-secret');

    await client.connect();
    await client.ready;

    expect(client.isReady()).toBe(true);
    expect(server.getConnectionCount()).toBe(1);
    expect(onConnected).toHaveBeenCalledOnce();
  });
});
