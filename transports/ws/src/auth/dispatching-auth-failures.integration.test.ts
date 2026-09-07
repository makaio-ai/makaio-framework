/** Real server coverage for auth-protocol refusal versus delegated infrastructure failure. */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DispatchingAuth } from './dispatching-auth.js';
import { HmacAuth } from './hmac-auth.js';
import { E2EAuth } from './e2e-auth.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';
import { ServerTransport } from '../server-transport.js';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { createTestServer } from '../__tests__/test-utils.js';

describe('dispatching authentication failure categories', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /**
   * Start a real server supporting both built-in authentication protocols.
   * @param hmac - HMAC verifier used by the dispatcher.
   * @returns Running server, client URL, and first connection's close code.
   */
  async function createDispatchingServer(hmac: HmacAuth) {
    const auth = new DispatchingAuth({
      hmac,
      e2e: new E2EAuth({
        signingKeyPair: await generateSigningKeyPair(),
        identityId: 'server',
        getPeerSigningKey: async () => null,
      }),
    });
    const { wss, port } = await createTestServer();
    const closed = new Promise<number>((resolve) => {
      wss.once('connection', (socket) => socket.once('close', resolve));
    });
    const server = new ServerTransport({ websocket: wss, auth });
    cleanups.push(() => server.disconnect());
    await server.connect();
    return { server, closed, url: `ws://127.0.0.1:${port}` };
  }

  it('closes an unsupported first authentication protocol with policy code 1008', async () => {
    const { server, closed, url } = await createDispatchingServer(new HmacAuth({ secret: 'test-secret' }));
    const client = new WebSocket(url);
    cleanups.push(() => client.terminate());
    const clientClosed = new Promise<number>((resolve, reject) => {
      client.once('close', resolve);
      client.once('error', reject);
    });
    client.once('message', () => client.send(JSON.stringify({ type: 'unsupported-auth-protocol' })));

    expect(await clientClosed).toBe(1008);
    expect(await closed).toBe(1008);
    expect(server.getConnectionCount()).toBe(0);
  });

  it('does not classify a delegated secret-store failure as protocol rejection', async () => {
    const { server, closed, url } = await createDispatchingServer(
      new HmacAuth({
        secret: 'test-secret',
        resolveSecret: () => {
          throw new Error('Secret store unavailable');
        },
      }),
    );
    const client = new WebSocketClientTransport({
      url,
      auth: new HmacAuth({ secret: 'test-secret', identityId: 'client' }),
      autoReconnect: false,
      heartbeat: false,
    });
    cleanups.push(() => client.disconnect());

    await expect(client.connect()).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    expect(await closed).toBe(1011);
    expect(client.isReady()).toBe(false);
    expect(server.getConnectionCount()).toBe(0);
  });
});
