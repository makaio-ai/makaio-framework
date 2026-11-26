import {
  WorkerExchangeListenerConfigurationError,
  type HonoRouteGraph,
  type SingleHostWorkerExchangeOptions,
  type WorkerExchangeListener,
} from '@makaio/runtime-node';
import type { WebSocketHandler } from 'bun';
import type { BunBootMakaioRuntimeOptions } from './boot.js';
import {
  createBunRouteGraphFetch,
  type BunExchangeUpgradeData,
  type BunExchangeUpgradeOptions,
} from './bun-route-graph-fetch.js';
import type { BunBusServerTransportProvider } from './bus-server-transport.js';
import type { BunServer } from './http-server-utils.js';

/** Native TLS listener inputs for the local worker exchange test seam. */
interface BunWorkerExchangeNativeListenerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly tls?: {
    readonly key: string | Uint8Array<ArrayBuffer>;
    readonly cert: string | Uint8Array<ArrayBuffer>;
  };
}

type BunWorkerExchangeServer = BunBootMakaioRuntimeOptions['bunServer'] & {
  stop(closeActiveConnections?: boolean): Promise<void>;
  unref(): void;
};

export const workerExchangeTestListeners = new WeakMap<BunServer, BunBusServerTransportProvider>();

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
  listener: Required<BunWorkerExchangeNativeListenerOptions>,
): BunWorkerExchangeServer {
  const server = serveBunExchange(transport, listener, undefined, routeGraph);
  workerExchangeTestListeners.set(server, transport);
  return server;
}

/**
 * Install the native handlers for either the test or the supported listener.
 * @param transport - Shared host WebSocket transport.
 * @param listener - Native bind and TLS inputs.
 * @param verifyIngress - Verifier for the TLS-terminating ingress.
 * @param routeGraph - HTTP route graph for a shared listener.
 * @returns The bound Bun server.
 */
function serveBunExchange(
  transport: BunBusServerTransportProvider,
  { maxPayloadLength, ...listener }: BunWorkerExchangeNativeListenerOptions & { readonly maxPayloadLength?: number },
  verifyIngress: BunExchangeUpgradeOptions['verifyIngress'],
  routeGraph?: HonoRouteGraph,
): BunWorkerExchangeServer {
  const fetch = createBunRouteGraphFetch(routeGraph, {
    directTls: listener.tls === undefined ? undefined : true,
    verifyIngress,
    hasPendingCapacity: () => transport.hasPendingExchangeCapacity,
  });
  return Bun.serve<BunExchangeUpgradeData | undefined>({
    ...listener,
    fetch: (request, native) =>
      fetch(request, {
        peerAddress: verifyIngress === undefined ? undefined : native.requestIP(request)?.address,
        upgrade: (target) => native.upgrade(target, { data: undefined }),
        upgradeExchange: (target, data) => native.upgrade(target, { data }),
      }),
    websocket: {
      ...(transport.createWebSocketHandler() as WebSocketHandler<BunExchangeUpgradeData | undefined>),
      maxPayloadLength,
    },
  }) as BunWorkerExchangeServer;
}

/**
 * Open the supported exchange-only listener for the Bun transport.
 * @param transport - Shared host WebSocket transport.
 * @param options - Validated bind and protection configuration.
 * @param maxBytes - Effective message budget from the boot exchange policy.
 * @returns The bound listener and its boot lifecycle.
 */
export function listenForBunWorkerExchange(
  transport: BunBusServerTransportProvider,
  { listen, security }: SingleHostWorkerExchangeOptions,
  maxBytes: number,
): WorkerExchangeListener {
  let server: BunWorkerExchangeServer;
  try {
    const tls = security.kind === 'tls' ? { cert: security.cert, key: security.key } : undefined;
    const verifyIngress: BunExchangeUpgradeOptions['verifyIngress'] =
      security.kind === 'verified-ingress'
        ? (request, peerAddress) => security.verifyIngress({ peerAddress, headers: request.headers })
        : undefined;
    server = serveBunExchange(
      transport,
      { hostname: listen.host, port: listen.port, tls, maxPayloadLength: maxBytes },
      verifyIngress,
    );
  } catch {
    throw new WorkerExchangeListenerConfigurationError('listen-failed');
  }
  return {
    address: { port: server.port, host: server.address?.address ?? server.hostname },
    async close() {
      server.unref();
      // Older Bun releases may leave the stop promise pending after an upgrade.
      void server.stop(true);
    },
  };
}
