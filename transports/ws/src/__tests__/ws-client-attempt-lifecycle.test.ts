import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BusMessage } from '@makaio/bus-core';
import { WebSocketClientTransport } from '../ws-client-transport.js';
import { HmacAuth } from '../auth/hmac-auth.js';
import { MockWebSocket } from './test-helpers.js';
import { waitForCondition } from './test-utils.js';

/** @returns A controllable async operation for injecting a lifecycle interruption. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('connection attempt ownership', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    'cancel',
    'expire',
  ] as const)('disposes a late factory socket after %s without replacing a new connection', async (mode) => {
    const factory = deferred<MockWebSocket>();
    const late = new MockWebSocket();
    const current = new MockWebSocket();
    const onConnected = vi.fn();
    let calls = 0;
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      autoReconnect: false,
      heartbeat: false,
      connectTimeoutMs: 40,
      createWebSocket: () => (++calls === 1 ? factory.promise : current),
      onConnected,
    });
    cleanups.push(() => transport.disconnect());
    const first = transport.connect();
    const rejected = expect(first).rejects.toMatchObject({
      code: mode === 'cancel' ? 'WS_CONNECTION_UNAVAILABLE' : 'WS_CONNECTION_TIMEOUT',
    });
    if (mode === 'cancel') await transport.disconnect();
    await rejected;
    await transport.connect();
    factory.resolve(late);
    await waitForCondition(() => late.readyState === 3, 1000);
    expect(transport.isReady()).toBe(true);
    expect(current.readyState).toBe(1);
    expect(onConnected).toHaveBeenCalledTimes(1);
    await expect(transport.connect()).rejects.toThrow('already connected');
  });

  it('cancels a socket-open wait and removes all attempt listeners', async () => {
    const socket = new MockWebSocket();
    socket.readyState = 0;
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: () => socket,
      autoReconnect: false,
    });
    cleanups.push(() => transport.disconnect());
    const connected = transport.connect();
    const rejected = expect(connected).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    await waitForCondition(() => (socket.listeners.get('open')?.size ?? 0) > 0, 1000);
    await transport.disconnect();
    await rejected;
    expect(socket.readyState).toBe(3);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('does not send a late encoded replay or clear a replacement session', async () => {
    const encoded = deferred<string>();
    const encoding = vi.fn(() => encoded.promise);
    const old = new MockWebSocket();
    const next = new MockWebSocket();
    let calls = 0;
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      autoReconnect: false,
      heartbeat: false,
      createWebSocket: () => (++calls === 1 ? old : next),
      codec: { encode: encoding, decode: async (message) => message as BusMessage },
    });
    cleanups.push(() => transport.disconnect());
    await transport.subscribe('test.subject');
    const first = transport.connect();
    const rejected = expect(first).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    await waitForCondition(() => encoding.mock.calls.length > 0, 1000);
    await transport.disconnect();
    // Start before the old connect's catch runs: it must not clear this owner.
    const second = transport.connect();
    await rejected;
    encoded.resolve('{"type":"subscribe","subjects":{}}');
    await second;
    expect(old.sentMessages).toHaveLength(0);
    expect(next.sentMessages).toHaveLength(1);
    expect(transport.isReady()).toBe(true);
    await expect(transport.connect()).rejects.toThrow('already connected');
  });

  it('does not resurrect a connection disconnected by onConnected', async () => {
    const socket = new MockWebSocket();
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: () => socket,
      autoReconnect: false,
      onConnected: () => {
        void transport.disconnect();
      },
    });
    cleanups.push(() => transport.disconnect());
    await expect(transport.connect()).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    expect(transport.isReady()).toBe(false);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('preserves an unknown factory rejection unchanged', async () => {
    const error = new Error('custom factory failure');
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: async () => {
        throw error;
      },
    });
    cleanups.push(() => transport.disconnect());
    await expect(transport.connect()).rejects.toBe(error);
  });

  it.each([
    'throw',
    'reject',
    'expire',
  ] as const)('settles its ready session after socket factory failure (%s)', async (mode) => {
    const factoryFailure = new Error('Socket factory failed');
    const factory = deferred<MockWebSocket>();
    const readySettled = vi.fn();
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      autoReconnect: false,
      connectTimeoutMs: 40,
      createWebSocket: () => {
        if (mode === 'throw') throw factoryFailure;
        if (mode === 'reject') return Promise.reject(factoryFailure);
        return factory.promise;
      },
    });
    transport.onNewReadySession = (ready) => {
      void ready.then(readySettled);
    };
    cleanups.push(() => transport.disconnect());

    const failure = await transport.connect().catch((error: unknown) => error);
    if (mode !== 'expire') expect(failure).toBe(factoryFailure);
    else expect(failure).toMatchObject({ code: 'WS_CONNECTION_TIMEOUT' });
    expect(readySettled).toHaveBeenCalledTimes(1);
    expect(transport.isReady()).toBe(false);
  });

  it('does not settle a replacement ready session when a cancelled factory returns late', async () => {
    const factory = deferred<MockWebSocket>();
    const old = new MockWebSocket();
    const current = new MockWebSocket();
    const replacementReady = vi.fn();
    let calls = 0;
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      autoReconnect: false,
      heartbeat: false,
      createWebSocket: () => (++calls === 1 ? factory.promise : current),
    });
    cleanups.push(() => transport.disconnect());
    const first = transport.connect();
    const rejected = expect(first).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    const disconnected = transport.disconnect();
    const second = transport.connect();
    void transport.ready.then(replacementReady);
    await Promise.all([disconnected, rejected, second]);
    factory.resolve(old);
    await waitForCondition(() => old.readyState === 3, 1000);
    expect(replacementReady).not.toHaveBeenCalled();

    current.receiveMessage(JSON.stringify({ type: 'subscribe-sync-complete' }));
    await transport.ready;
    expect(replacementReady).toHaveBeenCalledTimes(1);
    expect(transport.isReady()).toBe(true);
  });

  it('settles its advertised ready session if readiness notification throws', async () => {
    const notificationFailure = new Error('Readiness observer failed');
    const readySettled = vi.fn();
    const factory = vi.fn(() => new MockWebSocket());
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: factory,
      autoReconnect: false,
    });
    cleanups.push(() => transport.disconnect());
    transport.onNewReadySession = (ready) => {
      void ready.then(readySettled);
      throw notificationFailure;
    };

    await expect(transport.connect()).rejects.toBe(notificationFailure);
    expect(readySettled).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
    expect(transport.isReady()).toBe(false);
  });

  it.each([
    ['cancel', 'auth'],
    ['cancel', 'close'],
    ['cancel', 'both'],
    ['expire', 'auth'],
    ['expire', 'close'],
    ['expire', 'both'],
  ] as const)('settles %s and attempts all cleanup when %s cleanup throws', async (mode, fault) => {
    const auth = new HmacAuth({ secret: 'test-secret' });
    const cleanupAuth = auth.cleanup.bind(auth);
    const authFailure = new Error('custom auth cleanup failed');
    const closeFailure = new Error('custom socket close failed');
    const cleanup = vi.spyOn(auth, 'cleanup').mockImplementationOnce(() => {
      cleanupAuth();
      if (fault !== 'close') throw authFailure;
    });
    const socket = new MockWebSocket();
    const closeSocket = socket.close.bind(socket);
    const close = vi.spyOn(socket, 'close').mockImplementationOnce(() => {
      if (fault !== 'auth') throw closeFailure;
      closeSocket();
    });
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: () => socket,
      autoReconnect: false,
      heartbeat: false,
      connectTimeoutMs: 100,
      auth,
    });
    cleanups.push(async () => {
      cleanup.mockRestore();
      close.mockRestore();
      await transport.disconnect();
      socket.close();
    });
    const failed = transport.connect().catch((error: unknown) => error);
    await waitForCondition(() => (socket.listeners.get('message')?.size ?? 0) > 0, 1000);
    const ready = transport.ready;
    if (mode === 'cancel') await transport.disconnect();
    const error = await failed;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error('Expected cleanup failure details');
    expect(error.cause).toMatchObject({
      code: mode === 'cancel' ? 'WS_CONNECTION_UNAVAILABLE' : 'WS_CONNECTION_TIMEOUT',
    });
    expect(error.errors).toEqual([
      error.cause,
      ...(fault !== 'close' ? [authFailure] : []),
      ...(fault !== 'auth' ? [closeFailure] : []),
    ]);
    expect(error).not.toHaveProperty('code');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(transport.isReady()).toBe(false);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    await ready;
  });

  it('retains the original connection failure when failure cleanup also throws', async () => {
    const primary = new Error('custom authentication failure');
    const cleanupFailure = new Error('custom auth cleanup failure');
    const auth = new HmacAuth({ secret: 'test-secret' });
    vi.spyOn(auth, 'authenticateClient').mockRejectedValue(primary);
    const cleanup = vi.spyOn(auth, 'cleanup').mockImplementationOnce(() => {
      throw cleanupFailure;
    });
    const socket = new MockWebSocket();
    const close = vi.spyOn(socket, 'close');
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: () => socket,
      autoReconnect: false,
      auth,
    });
    cleanups.push(() => transport.disconnect());
    await expect(transport.connect()).rejects.toMatchObject({
      name: 'AggregateError',
      cause: primary,
      errors: [primary, cleanupFailure],
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(socket.readyState).toBe(3);
    expect(transport.isReady()).toBe(false);
    expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it.each(['auth', 'codec'] as const)('preserves an unknown %s rejection unchanged', async (phase) => {
    const error = new Error(`custom ${phase} failure`);
    const auth = new HmacAuth({ secret: 'test-secret' });
    vi.spyOn(auth, 'authenticateClient').mockRejectedValue(error);
    const socket = new MockWebSocket();
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: () => socket,
      autoReconnect: false,
      auth: phase === 'auth' ? auth : undefined,
      codec: {
        encode: async () => {
          throw error;
        },
        decode: async (message) => message as BusMessage,
      },
    });
    cleanups.push(() => transport.disconnect());
    await transport.subscribe('test.subject');
    await expect(transport.connect()).rejects.toBe(error);
    expect(socket.readyState).toBe(3);
  });

  it.each([
    'auth',
    'replay',
  ] as const)('bounds %s by the full attempt deadline and fences its late completion', async (phase) => {
    const work = deferred<string>();
    const auth = new HmacAuth({ secret: 'test-secret' });
    vi.spyOn(auth, 'authenticateClient').mockImplementation(async () => {
      await work.promise;
    });
    const socket = new MockWebSocket();
    const onConnected = vi.fn();
    const transport = new WebSocketClientTransport({
      url: 'ws://test',
      createWebSocket: () => socket,
      autoReconnect: false,
      heartbeat: false,
      auth: phase === 'auth' ? auth : undefined,
      connectTimeoutMs: 40,
      onConnected,
      codec: { encode: () => work.promise, decode: async (message) => message as BusMessage },
    });
    cleanups.push(() => transport.disconnect());
    await transport.subscribe('test.subject');
    await expect(transport.connect()).rejects.toMatchObject({ code: 'WS_CONNECTION_TIMEOUT' });
    work.resolve('{"type":"subscribe","subjects":{}}');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(socket.readyState).toBe(3);
    expect(socket.sentMessages).toHaveLength(0);
    expect(onConnected).not.toHaveBeenCalled();
    expect(transport.isReady()).toBe(false);
  });

  it('settles HMAC waits on global cleanup and does not emit an authentication refusal', async () => {
    const client = new HmacAuth({ secret: 'test-secret' });
    const server = new HmacAuth({ secret: 'test-secret' });
    const socket = new MockWebSocket();
    const clientWait = client.authenticateClient(() => {});
    const send = vi.fn();
    const serverWait = server.authenticateServer(socket, send);
    const assertions = [clientWait, serverWait].map((wait) =>
      expect(wait).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' }),
    );
    client.cleanup();
    server.cleanup();
    await Promise.all(assertions);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'auth-challenge' }));
  });

  it('fences an old client crypto completion after cleanup and a successful new handshake', async () => {
    const signature = deferred<ArrayBuffer>();
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(() => signature.promise);
    const auth = new HmacAuth({ secret: 'test-secret' });
    const oldSend = vi.fn();
    auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'old' });
    const old = auth.authenticateClient(oldSend);
    const rejected = expect(old).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    await waitForCondition(() => sign.mock.calls.length > 0, 1000);
    auth.cleanup();
    auth.handleAuthMessage({ type: 'auth-challenge', nonce: 'new' });
    const send = vi.fn(() => {
      auth.handleAuthMessage({ type: 'auth-result', success: true });
    });
    await auth.authenticateClient(send);
    signature.resolve(new ArrayBuffer(32));
    await rejected;
    expect(oldSend).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    auth.cleanup();
  });

  it('fences server crypto completion after socket cleanup', async () => {
    const signature = deferred<ArrayBuffer>();
    const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(() => signature.promise);
    const auth = new HmacAuth({ secret: 'test-secret' });
    const socket = new MockWebSocket();
    const send = vi.fn();
    const authenticated = auth.authenticateServer(socket, send);
    const rejected = expect(authenticated).rejects.toMatchObject({ code: 'WS_CONNECTION_UNAVAILABLE' });
    auth.handleAuthMessage({ type: 'auth-response', signature: '00'.repeat(32) }, socket);
    await waitForCondition(() => sign.mock.calls.length > 0, 1000);
    auth.cleanupSocket(socket);
    signature.resolve(new ArrayBuffer(32));
    await rejected;
    expect(auth.isSocketAuthenticated(socket)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    auth.cleanup();
  });
});
