import { afterEach, describe, expect, it, vi } from 'vitest';
import { E2EAuth } from './e2e-auth.js';
import { HmacAuth } from './hmac-auth.js';
import { resolveHmacIdentitySecret } from './identity-secret-registry.js';
import { generateSigningKeyPair, sign } from '../crypto/ecdsa.js';
import { encodeText } from '../crypto/encoding.js';
import { deriveE2ESessionKey } from './e2e-crypto-helpers.js';
import { exportPublicKey, generateECDHKeyPair } from '../crypto/ecdh.js';
import { WebSocket } from 'ws';
import { ServerTransport } from '../server-transport.js';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { MockWebSocket } from '../__tests__/test-helpers.js';
import { createTestServer } from '../__tests__/test-utils.js';

describe('built-in authentication failure categories', () => {
  const cleanups: Array<() => void | Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    vi.restoreAllMocks();
  });

  /**
   * Create real E2E authenticators with overridable peer-key lookup behavior.
   * @param options - Test-specific lookup and timeout configuration.
   * @returns Actual client/server authentication pair.
   */
  async function createPair(
    options: { clientLookup?: 'unknown' | 'wrong'; serverLookup?: 'unknown' | 'wrong' | Error; timeout?: number } = {},
  ) {
    const clientKeys = await generateSigningKeyPair();
    const serverKeys = await generateSigningKeyPair();
    const wrongKeys = await generateSigningKeyPair();
    const client = new E2EAuth({
      signingKeyPair: clientKeys,
      identityId: 'client',
      peerId: 'server',
      timeout: options.timeout,
      getPeerSigningKey: async () =>
        options.clientLookup === 'unknown'
          ? null
          : options.clientLookup === 'wrong'
            ? wrongKeys.publicKey
            : serverKeys.publicKey,
    });
    const server = new E2EAuth({
      signingKeyPair: serverKeys,
      identityId: 'server',
      timeout: options.timeout,
      getPeerSigningKey: async () => {
        if (options.serverLookup instanceof Error) throw options.serverLookup;
        return options.serverLookup === 'unknown'
          ? null
          : options.serverLookup === 'wrong'
            ? wrongKeys.publicKey
            : clientKeys.publicKey;
      },
    });
    cleanups.push(
      () => client.cleanup(),
      () => server.cleanup(),
    );
    return { client, server, clientKeys };
  }

  it.each([
    'unknown',
    'wrong',
  ] as const)('closes a real E2E %s-client refusal with 1008 and returns a typed client rejection', async (serverLookup) => {
    const pair = await createPair({ serverLookup });
    const { wss, port } = await createTestServer();
    const closed = new Promise<number>((resolve) => {
      wss.once('connection', (socket) => {
        socket.once('close', resolve);
      });
    });
    const server = new ServerTransport({ websocket: wss, auth: pair.server });
    cleanups.push(() => server.disconnect());
    await server.connect();
    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      auth: pair.client,
      autoReconnect: false,
      heartbeat: false,
    });
    cleanups.push(() => client.disconnect());
    await expect(client.connect()).rejects.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' });
    expect(await closed).toBe(1008);
    expect(server.getConnectionCount()).toBe(0);
  });

  it.each([
    'unknown',
    'wrong',
  ] as const)('classifies the client verifier rejecting an %s server', async (clientLookup) => {
    const { client, server } = await createPair({ clientLookup });
    const socket = new MockWebSocket();
    const serverDone = server.authenticateServer(socket, (message) => {
      client.handleAuthMessage(message);
    });
    const clientDone = client.authenticateClient((message) => {
      server.handleAuthMessage(message, socket);
    });
    await Promise.all([expect(clientDone).rejects.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' }), serverDone]);
    expect(client.getSessionKey()).toBeNull();
  });

  it.each([
    'client-exchange',
    'server-exchange',
    'client-result',
  ] as const)('classifies the %s wait timeout without manufacturing a credential refusal', async (phase) => {
    const { client, server } = await createPair({ timeout: 300 });
    const socket = new MockWebSocket();
    const serverSend = vi.fn((message: unknown) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'e2e-key-exchange-response'
      ) {
        client.handleAuthMessage(message);
      }
    });
    if (phase === 'server-exchange') {
      await expect(server.authenticateServer(socket, serverSend)).rejects.toMatchObject({
        code: 'WS_HANDSHAKE_TIMEOUT',
      });
      expect(serverSend).not.toHaveBeenCalled();
      return;
    }
    if (phase === 'client-exchange') {
      await expect(client.authenticateClient(() => {})).rejects.toMatchObject({ code: 'WS_HANDSHAKE_TIMEOUT' });
      return;
    }
    const serverDone = server.authenticateServer(socket, serverSend);
    const clientDone = client.authenticateClient((message) => {
      server.handleAuthMessage(message, socket);
    });
    await Promise.all([expect(clientDone).rejects.toMatchObject({ code: 'WS_HANDSHAKE_TIMEOUT' }), serverDone]);
    expect(client.getSessionKey()).toBeNull();
  });

  it('preserves an unknown key-store error and sends no negative authentication frame', async () => {
    const failure = new Error('Key store unavailable');
    const { client, server } = await createPair({ serverLookup: failure });
    const socket = new MockWebSocket();
    const serverSend = vi.fn((message: unknown) => {
      client.handleAuthMessage(message);
    });
    const serverDone = server.authenticateServer(socket, serverSend);
    const serverRejected = expect(serverDone).rejects.toBe(failure);
    const clientDone = client.authenticateClient((message) => {
      server.handleAuthMessage(message, socket);
    });
    const clientRejected = expect(clientDone).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    await serverRejected;
    expect(serverSend).not.toHaveBeenCalled();
    client.cleanup();
    await clientRejected;
  });

  it.each([
    { label: 'missing', success: undefined, verdict: true },
    { label: 'null', success: null, verdict: true },
    { label: 'string', success: 'false', verdict: true },
    { label: 'missing', success: undefined, verdict: false },
    { label: 'null', success: null, verdict: false },
    { label: 'string', success: 'false', verdict: false },
  ])('ignores a $label E2E result until a real boolean verdict ($verdict) arrives', async ({ success, verdict }) => {
    const { client, server } = await createPair();
    const socket = new MockWebSocket();
    const serverDone = server.authenticateServer(socket, (message) => {
      // Complete real key exchange, but let the test deliver the final verdict.
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'e2e-auth-result')
        return;
      client.handleAuthMessage(message);
    });
    const clientDone = client.authenticateClient((message) => {
      server.handleAuthMessage(message, socket);
    });
    const expected = verdict
      ? expect(clientDone).resolves.toBeUndefined()
      : expect(clientDone).rejects.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' });
    await serverDone;
    const malformed = JSON.parse(JSON.stringify({ type: 'e2e-auth-result', success }));
    expect(client.handleAuthMessage(malformed)).toBe(true);
    client.handleAuthMessage({ type: 'e2e-auth-result', success: verdict });
    await expected;
    if (verdict) expect(client.getSessionKey()).not.toBeNull();
    else expect(client.getSessionKey()).toBeNull();
  });

  it.each([
    { label: 'absent', signature: undefined },
    { label: 'null', signature: null },
    { label: 'number', signature: 42 },
    { label: 'object', signature: {} },
    { label: 'non-hex', signature: 'zz'.repeat(32) },
  ])('rejects a malformed HMAC $label signature as authentication failure', async ({ signature }) => {
    const server = new HmacAuth({ secret: 'test-secret' });
    cleanups.push(() => server.cleanup());
    const socket = new MockWebSocket();
    const send = vi.fn();
    const authenticated = server.authenticateServer(socket, send);
    const rejected = expect(authenticated).rejects.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' });
    // Exercise the actual runtime JSON boundary, not an asserted AuthMessage type.
    server.handleAuthMessage(JSON.parse(JSON.stringify({ type: 'auth-response', signature })), socket);
    await rejected;
    expect(server.isSocketAuthenticated(socket)).toBe(false);
    expect(send).toHaveBeenLastCalledWith({ type: 'auth-result', success: false, error: 'Invalid signature' });
  });

  it.each([
    { label: 'missing signature', field: 'signature', value: undefined },
    { label: 'non-string signature', field: 'signature', value: 42 },
    { label: 'non-hex signature', field: 'signature', value: 'zz'.repeat(64) },
    { label: 'short signature', field: 'signature', value: '00' },
    { label: 'missing public key', field: 'ephemeralPublicKey', value: undefined },
    { label: 'non-string public key', field: 'ephemeralPublicKey', value: 42 },
    { label: 'invalid base64url', field: 'ephemeralPublicKey', value: '%%%' },
    { label: 'non-string identity', field: 'deviceId', value: 42 },
  ])('rejects an E2E exchange with $label before crypto or key lookup', async ({ field, value }) => {
    const { server } = await createPair({ serverLookup: new Error('Malformed data must not reach the key store') });
    const socket = new MockWebSocket();
    const sent = vi.fn();
    const auth = server.authenticateServer(socket, sent);
    const refused = expect(auth).rejects.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' });
    const message = JSON.parse(
      JSON.stringify({
        type: 'e2e-key-exchange',
        deviceId: 'client',
        ephemeralPublicKey: 'AQID',
        signature: '00'.repeat(64),
        [field]: value,
      }),
    );
    expect(server.handleAuthMessage(message, socket)).toBe(true);
    await refused;
    expect(sent).toHaveBeenCalledOnce();
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'e2e-auth-result', success: false }));
  });

  it.each([
    { field: 'signature', value: undefined },
    { field: 'ephemeralPublicKey', value: 42 },
    { field: 'salt', value: undefined },
    { field: 'salt', value: 'bad-salt' },
  ])('rejects malformed E2E response field $field', async ({ field, value }) => {
    const { client, server } = await createPair();
    const socket = new MockWebSocket();
    const serverDone = server.authenticateServer(socket, (message) => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'e2e-key-exchange-response'
      ) {
        client.handleAuthMessage(JSON.parse(JSON.stringify({ ...message, [field]: value })));
      } else client.handleAuthMessage(message);
    });
    const clientDone = client.authenticateClient((message) => {
      server.handleAuthMessage(message, socket);
    });
    await Promise.all([expect(clientDone).rejects.toMatchObject({ code: 'WS_AUTHENTICATION_REJECTED' }), serverDone]);
    expect(client.getSessionKey()).toBeNull();
  });

  it('rejects a genuinely signed but invalid peer SPKI on a real socket with 1008', async () => {
    const pair = await createPair();
    const malformedKey = 'AQID';
    const signatureBytes = await sign(pair.clientKeys.privateKey, encodeText(`${malformedKey}client`));
    const signature = Array.from(signatureBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const { wss, port } = await createTestServer();
    const server = new ServerTransport({ websocket: wss, auth: pair.server });
    cleanups.push(() => server.disconnect());
    await server.connect();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => {
      socket.terminate();
    });
    const closed = new Promise<number>((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    socket.once('open', () => {
      socket.send(
        JSON.stringify({ type: 'e2e-key-exchange', deviceId: 'client', ephemeralPublicKey: malformedKey, signature }),
      );
    });
    expect(await closed).toBe(1008);
    expect(server.getConnectionCount()).toBe(0);
  });

  it('classifies only DataError at peer import and preserves other crypto failures', async () => {
    const ownKeys = await generateECDHKeyPair();
    const peerKeys = await generateECDHKeyPair();
    const peer = await exportPublicKey(peerKeys.publicKey);
    const salt = '00'.repeat(16);
    await expect(deriveE2ESessionKey(ownKeys.privateKey, 'AQID', salt, 'test')).rejects.toMatchObject({
      code: 'WS_AUTHENTICATION_REJECTED',
      cause: expect.objectContaining({ name: 'DataError' }),
    });
    const failedImport = new DOMException('Engine unavailable', 'OperationError');
    vi.spyOn(crypto.subtle, 'importKey').mockRejectedValueOnce(failedImport);
    await expect(deriveE2ESessionKey(ownKeys.privateKey, peer, salt, 'test')).rejects.toBe(failedImport);
    // DataError outside peer import must not be mistaken for malformed peer data.
    const failedDerivation = new DOMException('Internal derivation failure', 'DataError');
    vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValueOnce(failedDerivation);
    await expect(deriveE2ESessionKey(ownKeys.privateKey, peer, salt, 'test')).rejects.toBe(failedDerivation);
  });

  it.each([
    { label: 'object', error: { toString: 0 }, expected: 'Unknown error' },
    { label: 'number', error: 42, expected: 'Unknown error' },
    { label: 'null', error: null, expected: 'Unknown error' },
    { label: 'string', error: 'Peer refused this identity', expected: 'Peer refused this identity' },
  ])('preserves typed HMAC refusal with a $label diagnostic', async ({ error, expected }) => {
    const client = new HmacAuth({ secret: 'test-secret' });
    cleanups.push(() => client.cleanup());
    client.handleAuthMessage({ type: 'auth-challenge', nonce: 'challenge' });
    const done = client.authenticateClient(() => {
      client.handleAuthMessage(JSON.parse(JSON.stringify({ type: 'auth-result', success: false, error })));
    });
    await expect(done).rejects.toMatchObject({
      code: 'WS_AUTHENTICATION_REJECTED',
      message: `HMAC authentication failed: ${expected}`,
    });
  });

  it.each([
    { label: 'object', error: { toString: 0 }, expected: 'Unknown error' },
    { label: 'number', error: 42, expected: 'Unknown error' },
    { label: 'null', error: null, expected: 'Unknown error' },
    { label: 'string', error: 'Peer refused this identity', expected: 'Peer refused this identity' },
  ])('settles E2E refusal before key exchange with a $label diagnostic', async ({ error, expected }) => {
    const { client } = await createPair();
    const done = client.authenticateClient(() => {
      client.handleAuthMessage(JSON.parse(JSON.stringify({ type: 'e2e-auth-result', success: false, error })));
    });
    await expect(done).rejects.toMatchObject({
      code: 'WS_AUTHENTICATION_REJECTED',
      message: `E2E authentication failed: ${expected}`,
    });
    expect(client.getSessionKey()).toBeNull();
  });

  it('preserves typed E2E refusal after key exchange with an uncoercible diagnostic', async () => {
    const { client, server } = await createPair();
    const socket = new MockWebSocket();
    const serverDone = server.authenticateServer(socket, (message) => {
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'e2e-auth-result') {
        client.handleAuthMessage(JSON.parse('{"type":"e2e-auth-result","success":false,"error":{"toString":0}}'));
      } else client.handleAuthMessage(message);
    });
    const clientDone = client.authenticateClient((message) => {
      server.handleAuthMessage(message, socket);
    });
    await Promise.all([
      expect(clientDone).rejects.toMatchObject({
        code: 'WS_AUTHENTICATION_REJECTED',
        message: 'E2E authentication failed: Unknown error',
      }),
      serverDone,
    ]);
    expect(client.getSessionKey()).toBeNull();
  });

  it.each([
    { label: 'object', identityId: { toString: 0 } },
    { label: 'null', identityId: null },
  ])('rejects a malformed $label HMAC identity against the actual registry with close 1008', async ({ identityId }) => {
    const { wss, port } = await createTestServer();
    const auth = new HmacAuth({ secret: 'global-secret', resolveSecret: resolveHmacIdentitySecret });
    const server = new ServerTransport({ websocket: wss, auth });
    cleanups.push(() => server.disconnect());
    await server.connect();
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => {
      socket.terminate();
    });
    const closed = new Promise<number>((resolve, reject) => {
      socket.once('close', resolve);
      socket.once('error', reject);
    });
    socket.once('message', () => {
      socket.send(JSON.stringify({ type: 'auth-response', signature: '00'.repeat(32), identityId }));
    });
    expect(await closed).toBe(1008);
    expect(server.getConnectionCount()).toBe(0);
  });

  it('preserves a positive HMAC verdict send failure and removes accepted identity state', async () => {
    const server = new HmacAuth({
      secret: 'global-secret',
      resolveSecret: () => 'identity-secret',
      resolvePeer: () => ({ kind: 'device', id: 'client', authenticated: true }),
    });
    const client = new HmacAuth({ secret: 'identity-secret', identityId: 'client' });
    cleanups.push(
      () => server.cleanup(),
      () => client.cleanup(),
    );
    const socket = new MockWebSocket();
    const sendFailure = new Error('Positive verdict could not be delivered');
    const serverDone = server.authenticateServer(socket, (message) => {
      if (typeof message === 'object' && message !== null && 'success' in message) {
        expect(message.success).toBe(true);
        expect(socket.readyState).toBe(1);
        throw sendFailure;
      }
      client.handleAuthMessage(message);
    });
    const failed = expect(serverDone).rejects.toBe(sendFailure);
    const clientDone = client.authenticateClient((message) => {
      server.handleAuthMessage(message, socket);
    });
    const interrupted = expect(clientDone).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    await failed;
    expect(server.isSocketAuthenticated(socket)).toBe(false);
    expect(server.getReceiveContext(socket)).toBeUndefined();
    client.cleanup();
    await interrupted;
  });

  it('keeps the original HMAC refusal when sending its negative verdict throws', async () => {
    const server = new HmacAuth({ secret: 'test-secret' });
    cleanups.push(() => server.cleanup());
    const socket = new MockWebSocket();
    const serverDone = server.authenticateServer(socket, (message) => {
      if (typeof message === 'object' && message !== null && 'success' in message) {
        expect(message.success).toBe(false);
        throw new Error('Negative verdict could not be delivered');
      }
    });
    server.handleAuthMessage({ type: 'auth-response', signature: '00'.repeat(32) }, socket);
    await expect(serverDone).rejects.toMatchObject({
      code: 'WS_AUTHENTICATION_REJECTED',
      message: 'HMAC authentication failed: Invalid signature',
    });
    expect(server.isSocketAuthenticated(socket)).toBe(false);
  });

  it('does not admit a real socket when sending the positive HMAC verdict fails', async () => {
    const { wss, port } = await createTestServer();
    const failedSend = vi.fn();
    const closed = new Promise<number>((resolve) => {
      wss.once('connection', (socket) => {
        const send = socket.send.bind(socket);
        vi.spyOn(socket, 'send').mockImplementation((data) => {
          if (data === JSON.stringify({ type: 'auth-result', success: true })) {
            expect(socket.readyState).toBe(1);
            failedSend();
            throw new Error('Positive verdict could not be delivered');
          }
          send(data);
        });
        socket.once('close', resolve);
      });
    });
    const server = new ServerTransport({ websocket: wss, auth: new HmacAuth({ secret: 'test-secret' }) });
    cleanups.push(() => server.disconnect());
    await server.connect();
    const client = new WebSocketClientTransport({
      url: `ws://127.0.0.1:${port}`,
      auth: new HmacAuth({ secret: 'test-secret' }),
      autoReconnect: false,
      heartbeat: false,
    });
    cleanups.push(() => client.disconnect());
    await expect(client.connect()).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    expect(await closed).toBe(1011);
    expect(failedSend).toHaveBeenCalledOnce();
    expect(server.getConnectionCount()).toBe(0);
  });
});
