/**
 * BusServerTransportProvider — HTTP + WebSocket bus server transport for Node.js.
 *
 * Attaches an explicit `/bus` WebSocket upgrade handler to a pre-existing HTTP
 * server and starts the bus server on top of a path-gated `ws` server.
 *
 * Hosted composition roots own their Hono routes and HTTP server lifecycle.
 * This provider owns only the WebSocket bus transport layer.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IMakaioBus } from '@makaio/bus-core';
import { startBusServer, type BusServer, type TransportAuth } from '@makaio/bus-server';
import { DispatchingAuth } from '@makaio/bus-transport-websocket';
import type { TransportProvider } from '@makaio/kernel';
import { WebSocketServer } from 'ws';

/**
 * Whether an incoming upgrade should be handled as a bus connection.
 *
 * `/bus` is the canonical browser/dev URL. Pathless upgrades are allowed only
 * for clients without an `Origin` header so QR/mobile LAN URLs like
 * `ws://<host>:<port>` can connect without stealing browser HMR upgrades.
 * @param req - Upgrade request
 * @returns True when the request targets the bus transport
 */
function isBusUpgradeRequest(req: IncomingMessage): boolean {
  const path = req.url?.split('?')[0] ?? '';
  if (path === '/bus') {
    return true;
  }
  return (path === '/' || path === '') && req.headers.origin === undefined;
}

/**
 * Create the `/bus` upgrade handler for an HTTP server.
 * @param getWss - Returns the current bus WebSocket server instance
 * @param isBusReady - Returns whether the bus server has finished startup
 * @returns Upgrade handler that accepts canonical and LAN fallback bus upgrades
 */
function createBusUpgradeHandler(
  getWss: () => WebSocketServer | null,
  isBusReady: () => boolean,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!isBusUpgradeRequest(req)) {
      // Do NOT destroy the socket — other upgrade listeners (e.g., Vite HMR)
      // may handle it.
      return;
    }
    const wss = getWss();
    if (!wss || !isBusReady()) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  };
}

/**
 * Configuration options for {@link BusServerTransportProvider}.
 */
export interface BusServerTransportOptions {
  /** Pre-existing HTTP server that is already listening. */
  httpServer: HttpServer;
  /**
   * Auth strategy.
   *
   * When `undefined` the server runs with no authentication. Pass a
   * {@link DispatchingAuth} to support hot-swapping E2E auth after machine
   * identity is loaded.
   */
  auth?: TransportAuth;
  /**
   * Loopback transport registry name for in-process cross-client relay.
   *
   * Defaults to `'node'`.
   */
  loopbackName?: string;
}

const DEFAULT_LOOPBACK_NAME = 'node';

/**
 * Platform-specific bus server transport provider for Node.js.
 */
export class BusServerTransportProvider implements TransportProvider {
  private readonly options: BusServerTransportOptions;

  /** Active bus server instance. Set during connect, cleared on disconnect. */
  private busServer: BusServer | null = null;

  /** Active `ws` server instance. Set during connect, cleared on disconnect. */
  private websocketServer: WebSocketServer | null = null;

  /** HTTP server that currently owns the active upgrade handler. */
  private upgradeHandlerServer: HttpServer | null = null;

  /** Active `/bus` upgrade handler attached during connect. */
  private upgradeHandler: ((req: IncomingMessage, socket: Duplex, head: Buffer) => void) | null = null;

  /**
   * Whether the bus server has completed startup and is accepting connections.
   * Guards against WebSocket upgrade requests racing with bus startup.
   */
  private busReady = false;

  /**
   * Set synchronously at the top of {@link connect} to close the TOCTOU window
   * between the guard check and the first `await`.
   */
  private connecting = false;

  /**
   * @param options - Transport configuration. `httpServer` must already be listening.
   */
  public constructor(options: BusServerTransportOptions) {
    this.options = options;
  }

  /**
   * The {@link DispatchingAuth} instance if the caller passed one.
   *
   * Exposed so composition roots that need to hot-swap E2E auth after machine
   * identity becomes available can call `dispatchingAuth.setE2EAuth(e2eAuth)`.
   * @returns The {@link DispatchingAuth} instance, or `undefined` when auth was
   *   not provided or is not a `DispatchingAuth`.
   */
  public get dispatchingAuth(): DispatchingAuth | undefined {
    return this.options.auth instanceof DispatchingAuth ? this.options.auth : undefined;
  }

  /**
   * Attach the `/bus` upgrade handler to the HTTP server and start the bus server.
   * @param bus - Bus instance to attach the transport to.
   * @param _machineId - Machine identifier (unused; callers provide auth externally).
   */
  public async connect(bus: IMakaioBus, _machineId: string): Promise<void> {
    if (this.connecting || this.busServer || this.websocketServer) {
      throw new Error('[BusServerTransport] connect() called while transport is already connected or connecting');
    }
    if (this.options.httpServer.address() === null) {
      throw new Error('[BusServerTransport] httpServer must already be listening before connect() is called');
    }
    this.connecting = true;

    try {
      const websocketServer = new WebSocketServer({ noServer: true });
      this.websocketServer = websocketServer;

      const upgradeHandler = createBusUpgradeHandler(
        () => this.websocketServer,
        () => this.busReady,
      );
      this.options.httpServer.on('upgrade', upgradeHandler);
      this.upgradeHandlerServer = this.options.httpServer;
      this.upgradeHandler = upgradeHandler;

      this.busServer = await startBusServer({
        websocket: websocketServer,
        bus,
        auth: this.options.auth,
        loopbackName: this.options.loopbackName ?? DEFAULT_LOOPBACK_NAME,
      });
      this.busReady = true;
    } catch (error) {
      await this.stopBusServer('startup error');
      this.detachUpgradeHandler();
      await this.stopWebSocketServer('startup error');
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  /**
   * Stop the bus server and detach the upgrade wiring.
   *
   * The HTTP server and Hono app are owned by the composition root and are not
   * closed here.
   */
  public async disconnect(): Promise<void> {
    await this.stopBusServer('shutdown');
    this.detachUpgradeHandler();
    await this.stopWebSocketServer('shutdown');
  }

  /**
   * Stop the bus server and mark the transport as not ready.
   * @param reason - Context string used in error log messages.
   */
  private async stopBusServer(reason: string): Promise<void> {
    this.busReady = false;
    if (this.busServer) {
      await this.busServer.stop().catch((err: unknown) => {
        console.error(`[BusServerTransport] Failed to stop bus server during ${reason}:`, err);
      });
      this.busServer = null;
    }
  }

  /**
   * Detach the active upgrade handler from the HTTP server.
   */
  private detachUpgradeHandler(): void {
    if (this.upgradeHandlerServer && this.upgradeHandler) {
      this.upgradeHandlerServer.off('upgrade', this.upgradeHandler);
    }
    this.upgradeHandlerServer = null;
    this.upgradeHandler = null;
  }

  /**
   * Close the `ws` server.
   *
   * "The server is not running" is silently ignored: the HTTP server closes the
   * underlying socket when it shuts down first, so `wss.close()` finds it
   * already gone. This is not an error — it is the expected teardown order in
   * tests and in production when the HTTP server is closed before disconnect().
   * @param reason - Context string used in error log messages.
   */
  private async stopWebSocketServer(reason: string): Promise<void> {
    if (this.websocketServer) {
      await new Promise<void>((resolve, reject) => {
        this.websocketServer!.close((err) => (err ? reject(err) : resolve()));
      }).catch((err: unknown) => {
        // ws library (v8.x) throws this message when close() is called on
        // an already-stopped server. Not officially documented — fragile match.
        if (err instanceof Error && err.message === 'The server is not running') {
          return;
        }
        console.error(`[BusServerTransport] Failed to close WebSocket server during ${reason}:`, err);
      });
      this.websocketServer = null;
    }
  }
}
