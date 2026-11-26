/**
 * BusServerTransportProvider — HTTP + WebSocket bus server transport for Node.js.
 *
 * Attaches an explicit `/bus` WebSocket upgrade handler to a pre-existing HTTP
 * server and starts the bus server on top of a path-gated `ws` server.
 *
 * Hosted composition roots own their Hono routes and HTTP server lifecycle.
 * This provider owns only the WebSocket bus transport layer.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import type { IMakaioBus } from '@makaio/bus-core';
import { startBusServer, type BusServer, type TransportAuth } from '@makaio/bus-server';
import {
  CONNECTION_EXCHANGE_PATH,
  ConnectionExchangeAuth,
  DispatchingAuth,
  isLoopbackAddress,
  verifyConnectionExchangeIngress,
  type ConnectionExchangeSetup,
  type WebSocketLike,
} from '@makaio/bus-transport-websocket';
import { MAKAIO_LOOPBACK_PARTY_KIND, type TransportReceiveContext } from '@makaio/core';
import { WebSocketServer } from 'ws';
import type { WorkerExchangeIngressRequest } from './worker-exchange-listener.js';
import type { ServerTransportConnectOptions, ServerTransportProvider } from './boot-types.js';

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
 * @param exchange - Optional host exchange policy and upgrade verification.
 * @param exchangeOnly - Whether the listener serves only the protected exchange.
 * @returns Upgrade handler that accepts canonical and LAN fallback bus upgrades
 */
function createBusUpgradeHandler(
  getWss: () => WebSocketServer | null,
  isBusReady: () => boolean,
  exchange?: {
    auth: ConnectionExchangeAuth;
    websocket: WebSocketServer;
    verifyIngress?: (request: IncomingMessage) => boolean;
  },
  exchangeOnly = false,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const exchangeUpgrade = exchange !== undefined && req.url?.split('?')[0] === CONNECTION_EXCHANGE_PATH;
    if (exchangeOnly && !exchangeUpgrade) {
      socket.destroy();
      return;
    }
    if (!exchangeUpgrade && !isBusUpgradeRequest(req)) {
      // Do NOT destroy the socket — other upgrade listeners (e.g., Vite HMR)
      // may handle it.
      return;
    }
    const encrypted =
      exchangeUpgrade &&
      ((socket instanceof TLSSocket && socket.encrypted) ||
        verifyConnectionExchangeIngress(req, exchange.verifyIngress));
    if (exchangeUpgrade && !encrypted && (exchangeOnly || exchange.verifyIngress !== undefined)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const wss = getWss();
    if (!wss || !isBusReady()) {
      socket.destroy();
      return;
    }

    if (!exchangeUpgrade) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    if (!exchange.auth.hasPendingCapacity) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    exchange.websocket.handleUpgrade(req, socket, head, (ws) => {
      if (!exchange.auth.register(ws, { encrypted }, () => ws.terminate())) {
        ws.terminate();
        return;
      }
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
  /** Separate boot-created listener for worker upgrades. @internal */
  getWorkerExchangeListener?: () => HttpServer | undefined;
  /** Verifier for the boot-created protected ingress listener. @internal */
  verifyWorkerExchangeIngress?: (request: WorkerExchangeIngressRequest) => boolean;
  /**
   * Auth strategy.
   *
   * When `undefined` the server runs with no authentication. Pass a
   * {@link DispatchingAuth} to support hot-swapping E2E auth after machine
   * identity is loaded.
   */
  auth?: TransportAuth;
  /**
   * Custom exchange policy. Ordinary upgrades require explicit authentication.
   * The caller owns session replacement, owner ordering, and commit-time retirement.
   * Use the single-host boot option to have the framework wire those guarantees.
   */
  connectionExchange?: {
    readonly setup: ConnectionExchangeSetup;
    /**
     * Host verifier for a protected ingress, invoked for the accepted upgrade.
     * It runs synchronously, must return quickly, and must return exactly `true` to accept.
     * The host must establish encrypted peer transport for this upgrade through the protected ingress.
     */
    readonly verifyIngress?: (request: IncomingMessage) => boolean;
  };
  /**
   * Loopback transport registry name for in-process cross-client relay.
   *
   * Defaults to `'node'`.
   */
  loopbackName?: string;
}

const DEFAULT_LOOPBACK_NAME = 'node';

/**
 * Whether the HTTP server is listening only on a loopback address.
 *
 * The address is read from the already-bound server rather than configuration,
 * so a host cannot accidentally grant local control after binding a LAN socket.
 * @param httpServer - Listening HTTP server that owns the WebSocket upgrades.
 * @returns Whether the server is bound to a loopback TCP address.
 */
function isLoopbackListener(httpServer: HttpServer): boolean {
  const address = httpServer.address();
  if (address === null || typeof address === 'string') return false;
  return isLoopbackAddress(address.address);
}

/**
 * Supplies trusted host-local receive context for an unauthenticated loopback
 * listener. It intentionally does not authenticate the socket: the caller
 * (`makaio.loopback`) records how the server accepted the connection, while `authenticated` stays
 * false for downstream policy checks.
 */
class LoopbackReceiveContextAuth implements TransportAuth {
  private readonly contexts = new Map<WebSocketLike, TransportReceiveContext>();

  public async authenticateClient(_send: (message: unknown) => void): Promise<void> {}

  public async authenticateServer(socket: WebSocketLike, _send: (message: unknown) => void): Promise<void> {
    const connectionId = randomUUID();
    this.contexts.set(socket, {
      transportName: '',
      connectionId,
      authenticated: false,
      caller: { kind: MAKAIO_LOOPBACK_PARTY_KIND, id: connectionId },
    });
  }

  public handleAuthMessage(_message: unknown, _socket?: WebSocketLike): boolean {
    return false;
  }

  public getReceiveContext(socket?: WebSocketLike): TransportReceiveContext | undefined {
    return socket === undefined ? undefined : this.contexts.get(socket);
  }

  public cleanupSocket(socket: WebSocketLike): void {
    this.contexts.delete(socket);
  }

  public cleanup(): void {
    this.contexts.clear();
  }
}

/**
 * Platform-specific bus server transport provider for Node.js.
 */
export class BusServerTransportProvider implements ServerTransportProvider {
  private readonly options: BusServerTransportOptions;

  /** Active bus server instance. Set during connect, cleared on disconnect. */
  private busServer: BusServer | null = null;

  /** Active `ws` server instance. Set during connect, cleared on disconnect. */
  private websocketServer: WebSocketServer | null = null;

  /** Dedicated native receive limit for the exchange path. */
  private exchangeWebSocketServer: WebSocketServer | null = null;

  /** Cleanup for the upgrade handlers attached during connection. */
  private readonly removeUpgradeHandlers: (() => void)[] = [];

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
   * @param options - Host settings supplying the boundary access policy.
   */
  public async connect(bus: IMakaioBus, options: ServerTransportConnectOptions): Promise<void> {
    if (this.connecting || this.busServer || this.websocketServer) {
      throw new Error('[BusServerTransport] connect() called while transport is already connected or connecting');
    }
    if (this.options.httpServer.address() === null) {
      throw new Error('[BusServerTransport] httpServer must already be listening before connect() is called');
    }
    this.connecting = true;

    try {
      if (options.workerExchange !== undefined && this.options.connectionExchange !== undefined) {
        throw new Error('Only one worker connection exchange may be configured');
      }
      const setup =
        options.workerExchange === undefined
          ? this.options.connectionExchange
          : { setup: options.workerExchange.setup, verifyIngress: this.workerExchangeIngressVerifier() };
      const ordinaryAuth =
        this.options.auth ??
        (isLoopbackListener(this.options.httpServer) ? new LoopbackReceiveContextAuth() : undefined);
      const legacy = options.workerExchange === undefined ? this.options.auth : ordinaryAuth;
      if (setup !== undefined && legacy === undefined) {
        throw new Error('Connection exchange requires explicit legacy authentication');
      }
      const exchange =
        setup !== undefined && legacy !== undefined ? this.createExchangeServer(legacy, setup) : undefined;
      const websocketServer = new WebSocketServer({ noServer: true });
      this.websocketServer = websocketServer;

      this.attachUpgradeHandlers(exchange);

      const auth = exchange?.auth ?? ordinaryAuth;
      this.busServer = await startBusServer({
        websocket: websocketServer,
        bus,
        checkBoundaryAccess: options.checkBoundaryAccess,
        auth,
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
   * Create the separately bounded native server for exchange upgrades.
   * @param legacy - Auth policy handling ordinary upgrades.
   * @param options - Host policy handling exchange upgrades.
   * @returns Upgrade wiring feeding the shared framework bus server.
   */
  private createExchangeServer(
    legacy: TransportAuth,
    options: NonNullable<BusServerTransportOptions['connectionExchange']>,
  ) {
    const auth = new ConnectionExchangeAuth(legacy, options.setup);
    const websocket = new WebSocketServer({ noServer: true, maxPayload: options.setup.maxBytes });
    this.exchangeWebSocketServer = websocket;
    return { auth, websocket, verifyIngress: options.verifyIngress };
  }

  /**
   * Stop the bus server and mark the transport as not ready.
   * @param reason - Context string used in error log messages.
   */
  private async stopBusServer(reason: string): Promise<void> {
    this.busReady = false;
    if (this.busServer) {
      await this.busServer.stop().catch(() => {
        console.error(`[BusServerTransport] Failed to stop bus server during ${reason}`);
      });
      this.busServer = null;
    }
  }

  /**
   * Detach the active upgrade handler from the HTTP server.
   */
  private detachUpgradeHandler(): void {
    for (const remove of this.removeUpgradeHandlers.splice(0)) remove();
  }

  /**
   * Keep the ordinary and dedicated exchange listener policies separate.
   * @param exchange - Exchange upgrade wiring.
   */
  private attachUpgradeHandlers(
    exchange: ReturnType<BusServerTransportProvider['createExchangeServer']> | undefined,
  ): void {
    const listener = this.options.getWorkerExchangeListener?.();
    this.attachUpgradeHandler(this.options.httpServer, listener === undefined ? exchange : undefined);
    if (listener !== undefined) this.attachUpgradeHandler(listener, exchange, true);
  }

  /**
   * Attach one native listener to the bus transport.
   * @param server - HTTP server that owns the upgrades.
   * @param exchange - Exchange wiring, if that listener accepts it.
   * @param exchangeOnly - Whether the listener rejects ordinary upgrades.
   */
  private attachUpgradeHandler(
    server: HttpServer,
    exchange: ReturnType<BusServerTransportProvider['createExchangeServer']> | undefined,
    exchangeOnly = false,
  ): void {
    const handler = createBusUpgradeHandler(
      () => this.websocketServer,
      () => this.busReady,
      exchange,
      exchangeOnly,
    );
    server.on('upgrade', handler);
    this.removeUpgradeHandlers.push(() => server.off('upgrade', handler));
  }

  /**
   * Adapt native peer metadata for the shared boot verifier.
   * @returns Verifier for the exchange-only server, when configured.
   */
  private workerExchangeIngressVerifier() {
    const verify = this.options.verifyWorkerExchangeIngress;
    return verify === undefined
      ? undefined
      : (request: IncomingMessage) => {
          const headers = new Headers();
          for (let index = 0; index < request.rawHeaders.length; index += 2) {
            headers.append(request.rawHeaders[index], request.rawHeaders[index + 1]);
          }
          return verify({ peerAddress: request.socket.remoteAddress, headers });
        };
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
    for (const server of [this.websocketServer, this.exchangeWebSocketServer]) {
      if (server === null) continue;
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }).catch((err: unknown) => {
        // ws library (v8.x) throws this message when close() is called on
        // an already-stopped server. Not officially documented — fragile match.
        if (err instanceof Error && err.message === 'The server is not running') {
          return;
        }
        console.error(`[BusServerTransport] Failed to close WebSocket server during ${reason}`);
      });
    }
    this.websocketServer = null;
    this.exchangeWebSocketServer = null;
  }
}
