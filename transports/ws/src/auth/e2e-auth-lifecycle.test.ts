import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2EAuth } from './e2e-auth.js';
import { generateSigningKeyPair } from '../crypto/ecdsa.js';
import { encryptMessage, decryptMessage } from '../e2e-message-crypto.js';
import { MockWebSocket } from '../__tests__/test-helpers.js';
import { waitForCondition } from '../__tests__/test-utils.js';

/** @returns A deferred operation used to interrupt real crypto/auth flows. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** @returns Real signing keys and an authentication-pair factory. */
async function fixture() {
  const clientKeys = await generateSigningKeyPair();
  const serverKeys = await generateSigningKeyPair();
  return {
    clientKeys,
    serverKeys,
    client: (lookup = async () => serverKeys.publicKey) =>
      new E2EAuth({
        signingKeyPair: clientKeys,
        identityId: 'client',
        peerId: 'server',
        getPeerSigningKey: lookup,
      }),
    server: (lookup = async () => clientKeys.publicKey) =>
      new E2EAuth({
        signingKeyPair: serverKeys,
        identityId: 'server',
        getPeerSigningKey: lookup,
      }),
  };
}

/**
 * Start both real authentication flows with synchronous frame delivery.
 * @param client - Client authentication instance.
 * @param server - Server authentication instance.
 * @param socket - Server-side socket identity.
 * @returns Both authentication promises.
 */
function handshake(client: E2EAuth, server: E2EAuth, socket: MockWebSocket) {
  const serverDone = server.authenticateServer(socket, (message) => {
    client.handleAuthMessage(message);
  });
  const clientDone = client.authenticateClient((message) => {
    server.handleAuthMessage(message, socket);
  });
  return { clientDone, serverDone };
}

/**
 * Verify that the actual negotiated keys can still exchange encrypted messages.
 * @param client - Authenticated client.
 * @param server - Authenticated server.
 * @param socket - Authenticated server socket.
 */
async function assertUsableSession(client: E2EAuth, server: E2EAuth, socket: MockWebSocket): Promise<void> {
  const clientKey = client.getSessionKey();
  const serverKey = server.getSessionKey(socket);
  expect(clientKey).not.toBeNull();
  expect(serverKey).not.toBeNull();
  const message = {
    type: 'event',
    namespace: 'test',
    subject: 'test.value',
    messageId: 'message',
    payload: { value: 42 },
  } as const;
  await expect(decryptMessage(await encryptMessage(message, clientKey!), serverKey!)).resolves.toEqual(message);
}

describe('E2E authentication ownership', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    'resolve',
    'reject',
  ] as const)('does not mutate a replacement client session when the old lookup later %ss', async (outcome) => {
    const setup = await fixture();
    const lookup = deferred<CryptoKey>();
    let calls = 0;
    const client = setup.client(() => (++calls === 1 ? lookup.promise : Promise.resolve(setup.serverKeys.publicKey)));
    const oldServer = setup.server();
    const old = handshake(client, oldServer, new MockWebSocket());
    const oldError = new Error('late lookup failed');
    const rejected =
      outcome === 'resolve'
        ? expect(old.clientDone).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' })
        : expect(old.clientDone).rejects.toBe(oldError);
    await waitForCondition(() => calls === 1, 1000);
    await old.serverDone;
    expect(client.getSessionKey()).toBeNull();
    client.cleanup();
    const server = setup.server();
    const socket = new MockWebSocket();
    const current = handshake(client, server, socket);
    await Promise.all([current.clientDone, current.serverDone]);
    const currentKey = client.getSessionKey();
    if (outcome === 'resolve') lookup.resolve(setup.serverKeys.publicKey);
    else lookup.reject(oldError);
    await rejected;
    expect(client.getSessionKey()).toBe(currentKey);
    await assertUsableSession(client, server, socket);
    client.cleanup();
    server.cleanup();
    oldServer.cleanup();
  });

  it('does not publish or send from client crypto that completes after cleanup', async () => {
    const setup = await fixture();
    const barrier = deferred<void>();
    const originalSign = crypto.subtle.sign.bind(crypto.subtle);
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(async (...args) => {
      const signature = await originalSign(...args);
      await barrier.promise;
      return signature;
    });
    const client = setup.client();
    const send = vi.fn();
    const old = client.authenticateClient(send);
    const rejected = expect(old).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    await waitForCondition(() => sign.mock.calls.length > 0, 1000);
    client.cleanup();
    const server = setup.server();
    const socket = new MockWebSocket();
    const current = handshake(client, server, socket);
    await Promise.all([current.clientDone, current.serverDone]);
    const currentKey = client.getSessionKey();
    barrier.resolve();
    await rejected;
    expect(send).not.toHaveBeenCalled();
    expect(client.getSessionKey()).toBe(currentKey);
    await assertUsableSession(client, server, socket);
    client.cleanup();
    server.cleanup();
  });

  it('does not restore a cleaned server socket after its delayed key lookup completes', async () => {
    const setup = await fixture();
    const lookup = deferred<CryptoKey>();
    let calls = 0;
    const server = setup.server(() => (++calls === 1 ? lookup.promise : Promise.resolve(setup.clientKeys.publicKey)));
    const oldClient = setup.client();
    const oldSocket = new MockWebSocket();
    const old = handshake(oldClient, server, oldSocket);
    const rejectedServer = expect(old.serverDone).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    const rejectedClient = expect(old.clientDone).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    await waitForCondition(() => calls === 1, 1000);
    server.cleanupSocket(oldSocket);
    oldClient.cleanup();
    await rejectedClient;
    const client = setup.client();
    const socket = new MockWebSocket();
    const current = handshake(client, server, socket);
    await Promise.all([current.clientDone, current.serverDone]);
    lookup.resolve(setup.clientKeys.publicKey);
    await rejectedServer;
    expect(server.getSessionKey(oldSocket)).toBeNull();
    await assertUsableSession(client, server, socket);
    client.cleanup();
    server.cleanup();
  });

  it('settles pending key exchange waits on cleanup', async () => {
    const setup = await fixture();
    const client = setup.client();
    const server = setup.server();
    const sent = vi.fn();
    const clientDone = client.authenticateClient(sent);
    const serverDone = server.authenticateServer(new MockWebSocket(), () => {});
    const assertions = [clientDone, serverDone].map((pending) =>
      expect(pending).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' }),
    );
    await waitForCondition(() => sent.mock.calls.length > 0, 1000);
    client.cleanup();
    server.cleanup();
    await Promise.all(assertions);
    expect(client.getSessionKey()).toBeNull();
  });
});
