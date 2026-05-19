/// <reference types="bun-types" />
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { Server as HttpServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { createBusInstance } from '@makaio/bus-core';
import { startBusServer, type BusServer } from '@makaio/bus-server';
import { BusServerTransportProvider } from './bus-server-transport.js';

// ---------------------------------------------------------------------------
// Module-level mock state
// ---------------------------------------------------------------------------

const stopBusServerMock = mock(async () => undefined);
const closeWebSocketServerMock = mock((cb?: (err?: Error) => void) => cb?.());
const handleUpgradeMock = mock();
const WebSocketServerMock = mock(function () {
  return { close: closeWebSocketServerMock, handleUpgrade: handleUpgradeMock, emit: mock() };
});

mock.module('@makaio/bus-server', () => ({
  startBusServer: mock(async () => ({
    stop: stopBusServerMock,
  })),
}));

mock.module('ws', () => ({
  WebSocketServer: WebSocketServerMock,
}));

/**
 * Create a minimal HTTP server stub backed by EventEmitter with controllable
 * `on` / `off` / `close` / `address` methods.
 * @returns Mock HTTP server instance.
 */
function makeMockHttpServer(): HttpServer {
  const emitter = new EventEmitter();
  const onMock = mock(emitter.on.bind(emitter));
  const offMock = mock(emitter.off.bind(emitter));
  const closeMock = mock((cb?: (err?: Error) => void): HttpServer => {
    cb?.();
    return emitter as unknown as HttpServer;
  });
  const addressMock = mock(() => ({ port: 9999, family: 'IPv4', address: '127.0.0.1' }));

  return Object.assign(emitter, {
    on: onMock,
    off: offMock,
    close: closeMock,
    address: addressMock,
  }) as unknown as HttpServer;
}

describe('BusServerTransportProvider', () => {
  afterEach(() => {
    mock.clearAllMocks();
  });

  it('connects without error when given an HTTP server', async () => {
    const bus = createBusInstance();
    const transport = new BusServerTransportProvider({
      httpServer: makeMockHttpServer(),
    });

    await expect(transport.connect(bus, 'machine-1')).resolves.toBeUndefined();

    await transport.disconnect();
  });

  it('attaches a bus-specific upgrade handler to the HTTP server on connect', async () => {
    const bus = createBusInstance();
    const httpServer = makeMockHttpServer();
    const transport = new BusServerTransportProvider({
      httpServer,
    });

    await transport.connect(bus, 'machine-1');

    expect(httpServer.on).toHaveBeenCalledWith('upgrade', expect.any(Function));

    await transport.disconnect();
  });

  it('exposes dispatchingAuth when a DispatchingAuth is provided', async () => {
    const { DispatchingAuth, HmacAuth } = await import('@makaio/bus-transport-websocket');
    const auth = new DispatchingAuth({ hmac: new HmacAuth({ secret: 'test-secret' }) });
    const transport = new BusServerTransportProvider({
      httpServer: makeMockHttpServer(),
      auth,
    });

    expect(transport.dispatchingAuth).toBe(auth);
  });

  it('returns undefined dispatchingAuth for non-DispatchingAuth', async () => {
    const { HmacAuth } = await import('@makaio/bus-transport-websocket');
    const auth = new HmacAuth({ secret: 'test-secret' });
    const transport = new BusServerTransportProvider({
      httpServer: makeMockHttpServer(),
      auth,
    });

    expect(transport.dispatchingAuth).toBeUndefined();
  });

  it('throws when connect() is called twice without disconnect()', async () => {
    const bus = createBusInstance();
    const transport = new BusServerTransportProvider({
      httpServer: makeMockHttpServer(),
    });

    await transport.connect(bus, 'machine-1');

    await expect(transport.connect(bus, 'machine-2')).rejects.toThrow(
      '[BusServerTransport] connect() called while transport is already connected or connecting',
    );

    await transport.disconnect();
  });

  it('allows reconnect after disconnect()', async () => {
    const bus = createBusInstance();
    const transport = new BusServerTransportProvider({
      httpServer: makeMockHttpServer(),
    });

    await transport.connect(bus, 'machine-1');
    await transport.disconnect();

    await expect(transport.connect(bus, 'machine-2')).resolves.toBeUndefined();
    await transport.disconnect();
  });

  it('throws when httpServer is not listening yet', async () => {
    const bus = createBusInstance();
    const httpServer = makeMockHttpServer();
    (httpServer.address as ReturnType<typeof mock>).mockReturnValueOnce(null);

    const transport = new BusServerTransportProvider({
      httpServer,
    });

    await expect(transport.connect(bus, 'machine-1')).rejects.toThrow(
      '[BusServerTransport] httpServer must already be listening before connect() is called',
    );
  });

  it('stops bus server and websocket server on disconnect', async () => {
    const bus = createBusInstance();
    const transport = new BusServerTransportProvider({
      httpServer: makeMockHttpServer(),
    });

    await transport.connect(bus, 'machine-1');
    await transport.disconnect();

    expect(stopBusServerMock).toHaveBeenCalledTimes(1);
    expect(closeWebSocketServerMock).toHaveBeenCalledTimes(1);
  });

  it('detaches the upgrade handler on disconnect', async () => {
    const bus = createBusInstance();
    const httpServer = makeMockHttpServer();
    const transport = new BusServerTransportProvider({
      httpServer,
    });

    await transport.connect(bus, 'machine-1');
    await transport.disconnect();

    expect(httpServer.off).toHaveBeenCalledWith('upgrade', expect.any(Function));
  });

  it('does NOT close the HTTP server on disconnect', async () => {
    const bus = createBusInstance();
    const httpServer = makeMockHttpServer();
    const transport = new BusServerTransportProvider({
      httpServer,
    });

    await transport.connect(bus, 'machine-1');
    await transport.disconnect();

    const closeMock = (httpServer as unknown as { close: ReturnType<typeof mock> }).close;
    expect(closeMock).not.toHaveBeenCalled();
  });

  it('cleans up websocket resources when startBusServer rejects', async () => {
    (startBusServer as ReturnType<typeof mock>).mockRejectedValueOnce(new Error('bus start failure'));

    const bus = createBusInstance();
    const httpServer = makeMockHttpServer();
    const transport = new BusServerTransportProvider({
      httpServer,
    });

    await expect(transport.connect(bus, 'machine-1')).rejects.toThrow('bus start failure');

    expect(closeWebSocketServerMock).toHaveBeenCalledTimes(1);
    expect(httpServer.off).toHaveBeenCalledWith('upgrade', expect.any(Function));
  });

  describe('upgrade handler routing (isBusUpgradeRequest / createBusUpgradeHandler)', () => {
    /**
     * Create a minimal Duplex socket stub with a spy `destroy` method.
     * @returns Mock socket with a mock on `destroy`.
     */
    function makeMockSocket(): { destroy: ReturnType<typeof mock> } {
      return { destroy: mock() };
    }

    /**
     * Build a minimal {@link IncomingMessage}-shaped object for upgrade tests.
     * @param url - Request URL including path.
     * @param origin - Optional Origin header value.
     * @returns Minimal request stub.
     */
    function makeMockReq(url: string, origin?: string): { url: string; headers: Record<string, string | undefined> } {
      return { url, headers: origin !== undefined ? { origin } : {} };
    }

    /**
     * Connect the transport and return the connected provider so callers can
     * emit upgrade events through the supplied HTTP server.
     * @param httpServer - Mock HTTP server to connect against.
     * @returns Connected transport provider (already awaited).
     */
    async function connectTransport(
      httpServer: ReturnType<typeof makeMockHttpServer>,
    ): Promise<BusServerTransportProvider> {
      const bus = createBusInstance();
      const transport = new BusServerTransportProvider({
        httpServer,
      });
      await transport.connect(bus, 'machine-1');
      return transport;
    }

    it('routes /bus path to handleUpgrade', async () => {
      const httpServer = makeMockHttpServer();
      const transport = await connectTransport(httpServer);

      const socket = makeMockSocket();
      const head = Buffer.alloc(0);
      const req = makeMockReq('/bus');

      httpServer.emit('upgrade', req, socket, head);

      expect(handleUpgradeMock).toHaveBeenCalledTimes(1);
      expect(socket.destroy).not.toHaveBeenCalled();

      await transport.disconnect();
    });

    it('does NOT destroy socket or call handleUpgrade for non-bus path (/vite-hmr)', async () => {
      const httpServer = makeMockHttpServer();
      const transport = await connectTransport(httpServer);

      const socket = makeMockSocket();
      const head = Buffer.alloc(0);
      const req = makeMockReq('/vite-hmr');

      httpServer.emit('upgrade', req, socket, head);

      expect(handleUpgradeMock).not.toHaveBeenCalled();
      expect(socket.destroy).not.toHaveBeenCalled();

      await transport.disconnect();
    });

    it('routes root path / without Origin header to handleUpgrade (LAN mobile fallback)', async () => {
      const httpServer = makeMockHttpServer();
      const transport = await connectTransport(httpServer);

      const socket = makeMockSocket();
      const head = Buffer.alloc(0);
      const req = makeMockReq('/'); // no Origin → LAN client

      httpServer.emit('upgrade', req, socket, head);

      expect(handleUpgradeMock).toHaveBeenCalledTimes(1);
      expect(socket.destroy).not.toHaveBeenCalled();

      await transport.disconnect();
    });

    it('does NOT route root path / WITH Origin header (browser HMR should pass through)', async () => {
      const httpServer = makeMockHttpServer();
      const transport = await connectTransport(httpServer);

      const socket = makeMockSocket();
      const head = Buffer.alloc(0);
      const req = makeMockReq('/', 'http://localhost:5173');

      httpServer.emit('upgrade', req, socket, head);

      expect(handleUpgradeMock).not.toHaveBeenCalled();
      expect(socket.destroy).not.toHaveBeenCalled();

      await transport.disconnect();
    });

    it('destroys socket when bus is not ready (startBusServer pending)', async () => {
      // Delay startBusServer resolution so busReady stays false when we emit.
      let resolveBusServer!: () => void;
      const stubBusServer: BusServer = {
        stop: stopBusServerMock,
        start: mock(async () => undefined),
        getConnectionCount: mock(() => 0),
        transport: null!,
      };
      (startBusServer as ReturnType<typeof mock>).mockReturnValueOnce(
        new Promise<BusServer>((resolve) => {
          resolveBusServer = () => resolve(stubBusServer);
        }),
      );

      const bus = createBusInstance();
      const httpServer = makeMockHttpServer();
      const transport = new BusServerTransportProvider({
        httpServer,
      });

      // connect() is intentionally not awaited — busReady is still false.
      const connectPromise = transport.connect(bus, 'machine-1');

      const socket = makeMockSocket();
      const head = Buffer.alloc(0);
      const req = makeMockReq('/bus');

      httpServer.emit('upgrade', req, socket, head);

      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(handleUpgradeMock).not.toHaveBeenCalled();

      // Clean up: resolve the pending bus server and disconnect.
      resolveBusServer();
      await connectPromise;
      await transport.disconnect();
    });
  });
});
