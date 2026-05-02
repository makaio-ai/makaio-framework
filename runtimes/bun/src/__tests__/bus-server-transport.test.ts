/**
 * Unit tests for {@link BunBusServerTransportProvider} and the internal
 * {@link BunServerWebSocketAdapter}.
 *
 * Bun-specific runtime APIs are not required — the transport now exposes a
 * native WebSocket handler via {@link BunBusServerTransportProvider.createWebSocketHandler},
 * which is invoked directly in tests without a real Bun server.
 *
 * The internal {@link BunServerWebSocketAdapter} is a private class — it is
 * tested by:
 *  1. Calling `createWebSocketHandler()` to get the handler object.
 *  2. Invoking `handler.open(rawSocket)` (after connect) to trigger adapter
 *     creation and bridge acceptance.
 *  3. Intercepting the adapter via `bridge.on('connection', ...)` using a spy
 *     on the real {@link HonoWebSocketBridge}.
 *  4. Calling `handler.message` / `handler.close` and verifying dispatch.
 *
 * Test coverage:
 * - BunServerWebSocketAdapter — readyState, close()
 * - BunServerWebSocketAdapter — event dispatch: message / close / error
 * - BunServerWebSocketAdapter — send(): string, ArrayBuffer, ArrayBufferView, Blob
 * - BunServerWebSocketAdapter — removeEventListener
 * - BunBusServerTransportProvider — connect() / double-connect guard (TOCTOU)
 * - BunBusServerTransportProvider — disconnect() stops bus server and closes bridge
 * - BunBusServerTransportProvider — handler.open busReady guard
 * - BunBusServerTransportProvider — handler.message / handler.close routing
 * - BunBusServerTransportProvider — startup error cleanup
 * - BunBusServerTransportProvider — dispatchingAuth accessor
 * - BunBusServerTransportProvider — loopbackName forwarding
 * - BunBusServerTransportProvider — createWebSocketHandler binaryType
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { WebSocketCloseEvent } from '@makaio/bus-transport-websocket';
import {
  BunBusServerTransportProvider,
  type BunBusServerTransportOptions,
  RawServerWebSocket,
  BunWebSocketHandler,
} from '../bus-server-transport.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { stopBusServerMock } = vi.hoisted(() => {
  const stopBusServerMock = vi.fn(async (): Promise<void> => undefined);
  return { stopBusServerMock };
});

vi.mock('@makaio/bus-server', async (importOriginal) => {
  // Use the REAL HonoWebSocketBridge so we can spy on its accept() method and
  // test real adapter capture.
  const original = await importOriginal<typeof import('@makaio/bus-server')>();

  return {
    HonoWebSocketBridge: original.HonoWebSocketBridge,
    startBusServer: vi.fn(async () => ({
      stop: stopBusServerMock,
      start: vi.fn(async () => undefined),
      getConnectionCount: vi.fn(() => 0),
      transport: null,
    })),
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create a raw socket stub that records `send` and `close` calls, with a
 * controllable `readyState`.
 * @param readyState - WebSocket ready state. Defaults to `1` (OPEN).
 * @returns Mock raw `ServerWebSocket`.
 */
function makeRawSocket(readyState = 1): {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
} {
  return { send: vi.fn(), close: vi.fn(), readyState };
}

/**
 * The adapter shape visible to tests (public API of BunServerWebSocketAdapter).
 *
 * The adapter is a private class so we cast to this structural type when
 * obtained from bridge.accept().
 */
interface AdapterLike {
  readonly readyState: number;
  send(data: string | BufferSource | Blob): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: string, listener: (event: never) => void): void;
  removeEventListener(event: string, listener: (event: never) => void): void;
  dispatchMessage(data: string | ArrayBuffer): void;
  dispatchClose(code?: number, reason?: string): void;
  dispatchError(): void;
}

/**
 * Minimal structural type matching `HonoWebSocketBridge`'s `on` method so we
 * can intercept the adapter passed to `bridge.accept()` without importing the
 * private bridge type directly.
 */
interface BridgeLike {
  on(event: string, listener: (socket: unknown) => void): void;
}

/**
 * Tracks the most recently created transport so the file-scoped afterEach can
 * disconnect it if a test exits early (before its inline cleanup).
 */
let activeTransport: BunBusServerTransportProvider | undefined;

afterEach(async () => {
  try {
    await activeTransport?.disconnect();
  } finally {
    activeTransport = undefined;
    vi.clearAllMocks();
  }
});

/**
 * Create a transport that is always registered for file-level cleanup.
 *
 * Tests that fail before their inline cleanup still get disconnected by the
 * shared afterEach hook because this helper records the latest transport.
 * @param options - Provider configuration passed to the transport constructor.
 * @returns Tracked transport instance.
 */
function createTrackedTransport(options: BunBusServerTransportOptions = {}): BunBusServerTransportProvider {
  const transport = new BunBusServerTransportProvider(options);
  activeTransport = transport;
  return transport;
}

/**
 * Connect a transport and capture both the bridge passed to startBusServer and
 * the first adapter instance passed to bridge.accept() when `handler.open` fires.
 *
 * Returns helpers for invoking the WebSocket handler callbacks.
 * @param opts - Optional provider configuration overrides.
 * @returns Captured test fixtures.
 */
async function connectAndCapture(opts?: {
  /** Optional auth strategy to pass to the provider. */
  auth?: import('@makaio/bus-transport-websocket').TransportAuth;
  /** Optional loopback name to pass to the provider. */
  loopbackName?: string;
}): Promise<{
  transport: BunBusServerTransportProvider;
  handler: BunWebSocketHandler;
  rawSocket: ReturnType<typeof makeRawSocket>;
  adapter: AdapterLike;
}> {
  const { startBusServer } = await import('@makaio/bus-server');

  // Capture the bridge the provider passes to startBusServer.
  let capturedBridge: BridgeLike | null = null;
  vi.mocked(startBusServer).mockImplementationOnce(async (opts_) => {
    capturedBridge = opts_.websocket as BridgeLike;
    return {
      stop: stopBusServerMock,
      start: vi.fn(async () => undefined),
      getConnectionCount: vi.fn(() => 0),
      transport: null!,
    };
  });

  const transport = createTrackedTransport({ ...opts });
  const handler = transport.createWebSocketHandler();

  await transport.connect(createBusInstance(), 'machine-1');

  if (!capturedBridge) throw new Error('bridge was not captured — mockImplementationOnce did not fire');

  // Capture the adapter through bridge.accept().
  const bridge = capturedBridge as BridgeLike;
  let capturedAdapter: AdapterLike | null = null;
  bridge.on('connection', (socket) => {
    capturedAdapter = socket as AdapterLike;
  });

  const rawSocket = makeRawSocket();
  handler.open(rawSocket as RawServerWebSocket);

  if (!capturedAdapter)
    throw new Error('adapter was not captured via bridge.accept() — handler.open did not fire correctly');

  return { transport, handler, rawSocket, adapter: capturedAdapter };
}

// ---------------------------------------------------------------------------
// BunServerWebSocketAdapter tests
// ---------------------------------------------------------------------------

describe('BunServerWebSocketAdapter', () => {
  describe('readyState', () => {
    it('proxies readyState from the underlying raw socket', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();
      expect(adapter.readyState).toBe(rawSocket.readyState);
      await transport.disconnect();
    });
  });

  describe('close()', () => {
    it('delegates close() to the raw socket with code and reason', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();
      adapter.close(1001, 'going away');
      expect(rawSocket.close).toHaveBeenCalledWith(1001, 'going away');
      await transport.disconnect();
    });

    it('calls close() on the raw socket with no arguments', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();
      adapter.close();
      expect(rawSocket.close).toHaveBeenCalledOnce();
      await transport.disconnect();
    });
  });

  describe('dispatchMessage (message event)', () => {
    it('fires a MessageEvent with string data to registered listeners', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listener = vi.fn();

      adapter.addEventListener('message', listener);
      adapter.dispatchMessage('hello');

      expect(listener).toHaveBeenCalledOnce();
      const event = listener.mock.calls[0][0] as MessageEvent;
      expect(event).toBeInstanceOf(MessageEvent);
      expect(event.data).toBe('hello');
      await transport.disconnect();
    });

    it('fires a MessageEvent with ArrayBuffer data to registered listeners', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listener = vi.fn();
      const buffer = new ArrayBuffer(4);

      adapter.addEventListener('message', listener);
      adapter.dispatchMessage(buffer);

      expect(listener).toHaveBeenCalledOnce();
      const event = listener.mock.calls[0][0] as MessageEvent;
      expect(event.data).toBe(buffer);
      await transport.disconnect();
    });

    it('dispatches to all registered message listeners', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listenerA = vi.fn();
      const listenerB = vi.fn();

      adapter.addEventListener('message', listenerA);
      adapter.addEventListener('message', listenerB);
      adapter.dispatchMessage('data');

      expect(listenerA).toHaveBeenCalledOnce();
      expect(listenerB).toHaveBeenCalledOnce();
      await transport.disconnect();
    });
  });

  describe('dispatchClose (close event)', () => {
    it('fires a close event with code and reason', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listener = vi.fn();

      adapter.addEventListener('close', listener);
      adapter.dispatchClose(1001, 'going away');

      expect(listener).toHaveBeenCalledOnce();
      const event = listener.mock.calls[0][0] as WebSocketCloseEvent;
      expect(event).toBeInstanceOf(Event);
      expect(event.type).toBe('close');
      expect(event.code).toBe(1001);
      expect(event.reason).toBe('going away');
      await transport.disconnect();
    });

    it('uses code 1000 and empty reason when not provided', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listener = vi.fn();

      adapter.addEventListener('close', listener);
      adapter.dispatchClose();

      const event = listener.mock.calls[0][0] as WebSocketCloseEvent;
      expect(event.code).toBe(1000);
      expect(event.reason).toBe('');
      await transport.disconnect();
    });
  });

  describe('dispatchError (error event)', () => {
    it('fires an error Event to registered error listeners', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listener = vi.fn();

      adapter.addEventListener('error', listener);
      adapter.dispatchError();

      expect(listener).toHaveBeenCalledOnce();
      const event = listener.mock.calls[0][0] as Event;
      expect(event).toBeInstanceOf(Event);
      expect(event.type).toBe('error');
      await transport.disconnect();
    });
  });

  describe('removeEventListener', () => {
    it('removes a specific message listener so it no longer fires', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listener = vi.fn();

      adapter.addEventListener('message', listener);
      adapter.removeEventListener('message', listener);
      adapter.dispatchMessage('hi');

      expect(listener).not.toHaveBeenCalled();
      await transport.disconnect();
    });

    it('removes only the specified listener, leaving others intact', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listenerA = vi.fn();
      const listenerB = vi.fn();

      adapter.addEventListener('message', listenerA);
      adapter.addEventListener('message', listenerB);
      adapter.removeEventListener('message', listenerA);
      adapter.dispatchMessage('data');

      expect(listenerA).not.toHaveBeenCalled();
      expect(listenerB).toHaveBeenCalledOnce();
      await transport.disconnect();
    });

    it('silently ignores removeEventListener for an unknown event type', async () => {
      const { adapter, transport } = await connectAndCapture();
      const listener = vi.fn();

      expect(() => adapter.removeEventListener('unknown-event' as never, listener)).not.toThrow();
      await transport.disconnect();
    });
  });

  describe('send()', () => {
    it('sends a string directly to the raw socket', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();

      adapter.send('hello world');

      expect(rawSocket.send).toHaveBeenCalledWith('hello world');
      await transport.disconnect();
    });

    it('wraps an ArrayBuffer in Uint8Array and sends it', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();
      const buffer = new ArrayBuffer(8);

      adapter.send(buffer);

      expect(rawSocket.send).toHaveBeenCalledWith(new Uint8Array(buffer));
      await transport.disconnect();
    });

    it('sends an ArrayBufferView directly to the raw socket', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();
      const view = new Uint8Array([1, 2, 3]);

      adapter.send(view);

      expect(rawSocket.send).toHaveBeenCalledWith(view);
      await transport.disconnect();
    });

    it('resolves a Blob to Uint8Array and sends when socket is OPEN (readyState 1)', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();
      const blob = new Blob(['blobdata']);

      adapter.send(blob);

      // Blob.arrayBuffer() is async — flush microtasks.
      await vi.waitFor(() => expect(rawSocket.send).toHaveBeenCalledOnce());

      const sent = rawSocket.send.mock.calls[0][0];
      expect(sent).toBeInstanceOf(Uint8Array);
      await transport.disconnect();
    });

    it('suppresses Blob send when socket closes before the Blob resolves', async () => {
      const { rawSocket, adapter, transport } = await connectAndCapture();
      const blob = new Blob(['data']);
      let resolveArrayBuffer: ((buffer: ArrayBuffer) => void) | undefined;
      const pendingArrayBuffer = new Promise<ArrayBuffer>((resolve) => {
        resolveArrayBuffer = resolve;
      });
      vi.spyOn(blob, 'arrayBuffer').mockReturnValueOnce(pendingArrayBuffer);

      adapter.send(blob);

      // Mutate readyState to simulate the socket closing before blob resolution.
      rawSocket.readyState = 0;
      resolveArrayBuffer?.(new Uint8Array([1, 2, 3]).buffer);
      await pendingArrayBuffer;
      await Promise.resolve();

      expect(rawSocket.send).not.toHaveBeenCalled();
      await transport.disconnect();
    });

    it('dispatches an error event when Blob.arrayBuffer() rejects', async () => {
      const { adapter, transport } = await connectAndCapture();
      // Use a real Blob instance (passes instanceof check) but replace
      // arrayBuffer() with a rejecting spy.
      const failingBlob = new Blob(['data']);
      vi.spyOn(failingBlob, 'arrayBuffer').mockRejectedValueOnce(new Error('blob read failed'));

      const errorListener = vi.fn();
      adapter.addEventListener('error', errorListener);
      adapter.send(failingBlob);

      await vi.waitFor(() => expect(errorListener).toHaveBeenCalledOnce());
      await transport.disconnect();
    });
  });
});

// ---------------------------------------------------------------------------
// BunBusServerTransportProvider lifecycle tests
// ---------------------------------------------------------------------------

describe('BunBusServerTransportProvider', () => {
  describe('createWebSocketHandler()', () => {
    it('returns a handler with binaryType set to arraybuffer', () => {
      const transport = createTrackedTransport();
      const handler = transport.createWebSocketHandler();
      expect(handler.binaryType).toBe('arraybuffer');
    });

    it('returns a handler with open, message, and close callbacks', () => {
      const transport = createTrackedTransport();
      const handler = transport.createWebSocketHandler();
      expect(typeof handler.open).toBe('function');
      expect(typeof handler.message).toBe('function');
      expect(typeof handler.close).toBe('function');
    });
  });

  describe('connect()', () => {
    it('resolves without error and starts the bus server', async () => {
      const { startBusServer } = await import('@makaio/bus-server');
      const bus = createBusInstance();
      const transport = createTrackedTransport();

      await expect(transport.connect(bus, 'machine-1')).resolves.toBeUndefined();
      expect(startBusServer).toHaveBeenCalledOnce();

      await transport.disconnect();
    });

    it('passes the auth option to startBusServer', async () => {
      const { startBusServer } = await import('@makaio/bus-server');
      const { HmacAuth } = await import('@makaio/bus-transport-websocket');
      const auth = new HmacAuth({ secret: 'test-secret' });
      const bus = createBusInstance();
      const transport = createTrackedTransport({ auth });

      await transport.connect(bus, 'machine-1');

      expect(startBusServer).toHaveBeenCalledWith(expect.objectContaining({ auth }));

      await transport.disconnect();
    });
  });

  describe('double-connect guard (TOCTOU)', () => {
    it('throws when connect() is called while already connected', async () => {
      const bus = createBusInstance();
      const transport = createTrackedTransport();

      await transport.connect(bus, 'machine-1');

      await expect(transport.connect(bus, 'machine-2')).rejects.toThrow(
        '[BunBusServerTransport] connect() called while transport is already connected or connecting',
      );

      await transport.disconnect();
    });

    it('throws when connect() is called concurrently before startBusServer resolves', async () => {
      const { startBusServer } = await import('@makaio/bus-server');

      // Delay startBusServer so `connecting = true` but `busServer` is null.
      let resolveStartBusServer!: (value: import('@makaio/bus-server').BusServer) => void;
      vi.mocked(startBusServer).mockReturnValueOnce(
        new Promise<import('@makaio/bus-server').BusServer>((resolve) => {
          resolveStartBusServer = resolve;
        }),
      );

      const bus = createBusInstance();
      const transport = createTrackedTransport();

      // Start first connect but do NOT await — `connecting` is now true.
      const firstConnect = transport.connect(bus, 'machine-1');

      await expect(transport.connect(bus, 'machine-2')).rejects.toThrow(
        '[BunBusServerTransport] connect() called while transport is already connected or connecting',
      );

      resolveStartBusServer({
        stop: stopBusServerMock,
        start: vi.fn(async () => undefined),
        getConnectionCount: vi.fn(() => 0),
        transport: null!,
      });
      await firstConnect;
      await transport.disconnect();
    });
  });

  describe('disconnect()', () => {
    it('stops the bus server when disconnecting', async () => {
      const transport = createTrackedTransport();
      await transport.connect(createBusInstance(), 'machine-1');

      await transport.disconnect();

      expect(stopBusServerMock).toHaveBeenCalledOnce();
    });

    it('closes the bridge when disconnecting', async () => {
      const { HonoWebSocketBridge } = await import('@makaio/bus-server');
      const closeSpy = vi.spyOn(HonoWebSocketBridge.prototype, 'close');

      try {
        const transport = createTrackedTransport();
        await transport.connect(createBusInstance(), 'machine-1');

        await transport.disconnect();

        expect(closeSpy).toHaveBeenCalledOnce();
      } finally {
        closeSpy.mockRestore();
      }
    });

    it('does not throw when disconnect() is called without a prior connect()', async () => {
      const transport = createTrackedTransport();

      await expect(transport.disconnect()).resolves.toBeUndefined();
    });

    it('allows reconnect after disconnect', async () => {
      const { HonoWebSocketBridge } = await import('@makaio/bus-server');
      const acceptSpy = vi.spyOn(HonoWebSocketBridge.prototype, 'accept');
      try {
        const bus = createBusInstance();
        const transport = createTrackedTransport();
        const handler = transport.createWebSocketHandler();

        await transport.connect(bus, 'machine-1');
        await transport.disconnect();

        await expect(transport.connect(bus, 'machine-2')).resolves.toBeUndefined();

        const rawSocket = makeRawSocket();
        handler.open(rawSocket as RawServerWebSocket);

        // close() should not be called — busReady is true after second connect.
        expect(rawSocket.close).not.toHaveBeenCalled();
        expect(acceptSpy).toHaveBeenCalledOnce();
        await transport.disconnect();
      } finally {
        acceptSpy.mockRestore();
      }
    });
  });

  describe('busReady flag and handler.open guard', () => {
    it('closes the connection with code 1013 when busReady is false (before connect())', () => {
      const transport = createTrackedTransport();
      const handler = transport.createWebSocketHandler();

      const rawSocket = makeRawSocket();
      handler.open(rawSocket as RawServerWebSocket);

      expect(rawSocket.close).toHaveBeenCalledWith(1013, 'Bus server not ready');
    });

    it('does NOT close the connection when busReady is true (after connect())', async () => {
      const { transport, handler } = await connectAndCapture();

      // Call open a second time — busReady is already set so it should not reject.
      const secondRaw = makeRawSocket();
      handler.open(secondRaw as RawServerWebSocket);

      expect(secondRaw.close).not.toHaveBeenCalled();
      await transport.disconnect();
    });

    it('resets busReady to false after disconnect so new connections are rejected', async () => {
      const { transport, handler } = await connectAndCapture();
      await transport.disconnect();

      const rawSocket = makeRawSocket();
      handler.open(rawSocket as RawServerWebSocket);

      expect(rawSocket.close).toHaveBeenCalledWith(1013, 'Bus server not ready');
    });
  });

  describe('handler.message / handler.close routing', () => {
    it('handler.message forwards data to the active adapter', async () => {
      const { adapter, handler, rawSocket, transport } = await connectAndCapture();

      const messageListener = vi.fn();
      adapter.addEventListener('message', messageListener);
      handler.message(rawSocket as RawServerWebSocket, 'test-payload');

      expect(messageListener).toHaveBeenCalledOnce();
      expect((messageListener.mock.calls[0][0] as MessageEvent).data).toBe('test-payload');
      await transport.disconnect();
    });

    it('handler.message forwards ArrayBuffer data to the active adapter', async () => {
      const { adapter, handler, rawSocket, transport } = await connectAndCapture();
      const buffer = new ArrayBuffer(4);

      const messageListener = vi.fn();
      adapter.addEventListener('message', messageListener);
      handler.message(rawSocket as RawServerWebSocket, buffer);

      expect(messageListener).toHaveBeenCalledOnce();
      expect((messageListener.mock.calls[0][0] as MessageEvent).data).toBe(buffer);
      await transport.disconnect();
    });

    it('handler.close forwards code and reason to the active adapter', async () => {
      const { adapter, handler, rawSocket, transport } = await connectAndCapture();

      const closeListener = vi.fn();
      adapter.addEventListener('close', closeListener);
      handler.close(rawSocket as RawServerWebSocket, 1001, 'going away');

      expect(closeListener).toHaveBeenCalledOnce();
      const event = closeListener.mock.calls[0][0] as WebSocketCloseEvent;
      expect(event.code).toBe(1001);
      expect(event.reason).toBe('going away');
      await transport.disconnect();
    });

    it('handler.close removes the adapter so subsequent message calls are no-ops', async () => {
      const { adapter, handler, rawSocket, transport } = await connectAndCapture();

      const messageListener = vi.fn();
      adapter.addEventListener('message', messageListener);
      handler.close(rawSocket as RawServerWebSocket, 1000, '');

      // After close the adapter is removed from the WeakMap — message must not dispatch.
      handler.message(rawSocket as RawServerWebSocket, 'late');
      expect(messageListener).not.toHaveBeenCalled();
      await transport.disconnect();
    });

    it('handler.message is a no-op before handler.open fires (no active adapter)', () => {
      const transport = createTrackedTransport();
      const handler = transport.createWebSocketHandler();
      const rawSocket = makeRawSocket();

      // No open called — adapter is not in the WeakMap. Must not throw.
      expect(() => handler.message(rawSocket as RawServerWebSocket, 'orphan')).not.toThrow();
    });

    it('handler.close is a no-op before handler.open fires (no active adapter)', () => {
      const transport = createTrackedTransport();
      const handler = transport.createWebSocketHandler();
      const rawSocket = makeRawSocket();

      // No open called — adapter is not in the WeakMap. Must not throw.
      expect(() => handler.close(rawSocket as RawServerWebSocket, 1000, '')).not.toThrow();
    });
  });

  describe('startup error cleanup', () => {
    it('rethrows the error when startBusServer rejects', async () => {
      const { startBusServer } = await import('@makaio/bus-server');
      vi.mocked(startBusServer).mockRejectedValueOnce(new Error('bus startup failed'));

      const transport = createTrackedTransport();

      await expect(transport.connect(createBusInstance(), 'machine-fail')).rejects.toThrow('bus startup failed');
    });

    it('allows reconnect after a failed connect()', async () => {
      const { startBusServer } = await import('@makaio/bus-server');
      vi.mocked(startBusServer).mockRejectedValueOnce(new Error('bus startup failed'));

      const bus = createBusInstance();
      const transport = createTrackedTransport();

      await expect(transport.connect(bus, 'machine-fail')).rejects.toThrow('bus startup failed');
      await expect(transport.connect(bus, 'machine-retry')).resolves.toBeUndefined();
      await transport.disconnect();
    });

    it('does not set busReady after a failed connect()', async () => {
      const { startBusServer } = await import('@makaio/bus-server');
      vi.mocked(startBusServer).mockRejectedValueOnce(new Error('bus startup failed'));

      const transport = createTrackedTransport();
      const handler = transport.createWebSocketHandler();

      await expect(transport.connect(createBusInstance(), 'machine-fail')).rejects.toThrow('bus startup failed');

      const rawSocket = makeRawSocket();
      handler.open(rawSocket as RawServerWebSocket);

      expect(rawSocket.close).toHaveBeenCalledWith(1013, 'Bus server not ready');
    });
  });

  describe('dispatchingAuth accessor', () => {
    it('returns the DispatchingAuth instance when one is provided', async () => {
      const { DispatchingAuth, HmacAuth } = await import('@makaio/bus-transport-websocket');
      const auth = new DispatchingAuth({ hmac: new HmacAuth({ secret: 'test-secret' }) });
      const transport = createTrackedTransport({ auth });

      expect(transport.dispatchingAuth).toBe(auth);
    });

    it('returns undefined when a non-DispatchingAuth strategy is provided', async () => {
      const { HmacAuth } = await import('@makaio/bus-transport-websocket');
      const auth = new HmacAuth({ secret: 'test-secret' });
      const transport = createTrackedTransport({ auth });

      expect(transport.dispatchingAuth).toBeUndefined();
    });

    it('returns undefined when no auth is provided', () => {
      const transport = createTrackedTransport();

      expect(transport.dispatchingAuth).toBeUndefined();
    });
  });

  describe('loopbackName option', () => {
    it('passes the default loopback name "bun" to startBusServer', async () => {
      const { startBusServer } = await import('@makaio/bus-server');
      const transport = createTrackedTransport();

      await transport.connect(createBusInstance(), 'machine-1');

      expect(startBusServer).toHaveBeenCalledWith(expect.objectContaining({ loopbackName: 'bun' }));
      await transport.disconnect();
    });

    it('passes a custom loopback name to startBusServer when provided', async () => {
      const { startBusServer } = await import('@makaio/bus-server');
      const transport = createTrackedTransport({ loopbackName: 'custom-relay' });

      await transport.connect(createBusInstance(), 'machine-1');

      expect(startBusServer).toHaveBeenCalledWith(expect.objectContaining({ loopbackName: 'custom-relay' }));
      await transport.disconnect();
    });
  });
});
