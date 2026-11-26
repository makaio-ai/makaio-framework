/**
 * Makaio runtime boot sequence — Bun platform entry point.
 *
 * Thin wrapper around the platform-agnostic {@link bootMakaioRuntimeCore}
 * from `@makaio/runtime-node`. Accepts a pre-constructed
 * {@link BunBusServerTransportProvider} and a Bun server handle, then
 * delegates all startup logic to the shared core.
 *
 * The composition root is responsible for the following steps before calling
 * {@link bootMakaioRuntime}:
 * 1. Create a {@link BunBusServerTransportProvider}.
 * 2. Call {@link BunBusServerTransportProvider.createWebSocketHandler} to
 *    obtain a native Bun WebSocket handler.
 * 3. Start the Bun server via `Bun.serve({ fetch, websocket, port })`,
 *    passing the handler from step 2.
 * 4. Call `bootMakaioRuntime({ transport, bunServer, ...options })`.
 *
 * This ordering ensures the WebSocket handler is registered with `Bun.serve`
 * before boot starts, and that the handler remains valid across Hono route
 * graph rebuilds (which create a fresh `new Hono()` but do not affect the
 * native Bun server or its WebSocket handler).
 * @example
 * ```typescript
 * import {
 *   BunBusServerTransportProvider,
 *   bootMakaioRuntime,
 *   createBunRouteGraphFetch,
 * } from '@makaio/runtime-bun';
 *
 * const transport = new BunBusServerTransportProvider({ auth });
 * const websocket = transport.createWebSocketHandler();
 * const bunServer = Bun.serve({ fetch: createBunRouteGraphFetch(routeGraph), websocket, port: 3000 });
 * const runtime = await bootMakaioRuntime({ transport, bunServer });
 * console.log(`Listening on port ${runtime.port}`);
 * ```
 */

import {
  bootMakaioRuntimeCore,
  type CoreBootOptions,
  type HonoRouteGraph,
  type MakaioRuntime,
} from '@makaio/runtime-node';
import type { WebSocketHandler } from 'bun';
import { createBunRouteGraphFetch, type BunExchangeUpgradeData } from './bun-route-graph-fetch.js';
import type { BunBusServerTransportProvider } from './bus-server-transport.js';
import { type BunServer } from './http-server-utils.js';

/**
 * Options for {@link bootMakaioRuntime} (Bun platform).
 *
 * Extends the platform-agnostic {@link CoreBootOptions} with the Bun server
 * instance and the pre-constructed transport. The composition root creates the
 * transport and extracts the WebSocket handler before starting the Bun server,
 * then passes both here. For `workerExchangeTest`, use
 * {@link serveBunWorkerExchangeTest} to construct the listener with the same transport.
 */
export interface BunBootMakaioRuntimeOptions extends CoreBootOptions {
  /**
   * Bun server instance, already listening.
   *
   * Must be started with the WebSocket handler obtained from
   * {@link BunBusServerTransportProvider.createWebSocketHandler} so that the
   * bus transport can accept connections.
   */
  bunServer: BunServer & {
    /** Native TCP socket address exposed by Bun. Required for worker exchange tests. */
    readonly address?: { readonly address: string } | null;
  };

  /**
   * Pre-constructed bus server transport provider.
   *
   * The composition root creates the transport, calls
   * {@link BunBusServerTransportProvider.createWebSocketHandler} to get the
   * native handler for `Bun.serve`, then passes the transport here.
   * This ensures the WebSocket handler is registered before boot begins.
   */
  transport: BunBusServerTransportProvider;
}

/** Native TLS listener inputs for the local worker exchange test seam. */
interface BunWorkerExchangeTestListenerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly tls: {
    readonly key: string | Uint8Array<ArrayBuffer>;
    readonly cert: string | Uint8Array<ArrayBuffer>;
  };
}

type BunWorkerExchangeTestServer = BunBootMakaioRuntimeOptions['bunServer'] & {
  stop(closeActiveConnections?: boolean): Promise<void>;
  unref(): void;
};

const workerExchangeTestListeners = new WeakMap<BunServer, BunBusServerTransportProvider>();

/**
 * Start a native TLS listener with exchange-enabled route graph fetch and WebSocket handlers.
 *
 * Pass the returned server and the same transport to `bootMakaioRuntime` with
 * `workerExchangeTest`. Keep the installed handlers for the life of the test.
 * The caller owns the listener and must stop it even if boot fails.
 * @param routeGraph - Stable facade for the host's HTTP routes.
 * @param transport - Transport that will be passed to boot.
 * @param listener - TCP bind and native TLS certificate and key.
 * @returns The listening Bun server.
 * @internal
 */
export function serveBunWorkerExchangeTest(
  routeGraph: HonoRouteGraph,
  transport: BunBusServerTransportProvider,
  listener: BunWorkerExchangeTestListenerOptions,
): BunWorkerExchangeTestServer {
  const fetch = createBunRouteGraphFetch(routeGraph, {
    directTls: true,
    hasPendingCapacity: () => transport.hasPendingExchangeCapacity,
  });
  const server = Bun.serve<BunExchangeUpgradeData | undefined>({
    hostname: listener.hostname,
    port: listener.port,
    tls: listener.tls,
    fetch: (request, native) =>
      fetch(request, {
        upgrade: (target) => native.upgrade(target, { data: undefined }),
        upgradeExchange: (target, data) => native.upgrade(target, { data }),
      }),
    websocket: transport.createWebSocketHandler() as WebSocketHandler<BunExchangeUpgradeData | undefined>,
  }) as BunWorkerExchangeTestServer;
  workerExchangeTestListeners.set(server, transport);
  return server;
}

/**
 * Boot the full Makaio runtime against a pre-existing Bun server.
 *
 * Delegates all startup logic to the platform-agnostic
 * {@link bootMakaioRuntimeCore}. The caller owns the Bun server and transport
 * lifecycle. This function owns everything from step 1 (Config) through
 * step 12 (Ready) and returns a {@link MakaioRuntime} handle that the caller
 * uses to shut down.
 * @param options - Boot configuration including the pre-bound Bun server and
 *   pre-constructed transport provider.
 * @returns Runtime handle with `port`, `machineId`, and `shutdown()`.
 */
export async function bootMakaioRuntime(options: BunBootMakaioRuntimeOptions): Promise<MakaioRuntime> {
  const { port, hostname } = options.bunServer;
  if (options.workerExchangeTest !== undefined) {
    // Bun exposes address at runtime but omits it from its published types.
    // The test opt-in fails closed if the native address is unavailable.
    if (options.bunServer.address?.address !== hostname) {
      throw new Error('Worker exchange test mode requires a loopback listener with a matching Bun socket address');
    }
    if (workerExchangeTestListeners.get(options.bunServer) !== options.transport) {
      throw new Error(
        'Worker exchange test mode requires a Bun exchange-capable fetch: pass the server from serveBunWorkerExchangeTest and the same transport',
      );
    }
  }
  const createMount = options.createMount ?? (await import('./create-static-mount.js')).defaultCreateMount;
  return bootMakaioRuntimeCore(options.transport, port, hostname, {
    ...options,
    createMount,
  });
}
