import { CONNECTION_EXCHANGE_PATH, verifyConnectionExchangeIngress } from '@makaio/bus-transport-websocket';
import type { HonoRouteGraph } from '@makaio/runtime-node';

/** Tags host-only data carried from fetch to the native WebSocket handler. */
export const BUN_EXCHANGE_UPGRADE = Symbol('connection-exchange-upgrade');

/** No peer-controlled values are stored in native upgrade data. */
export interface BunExchangeUpgradeData {
  readonly [BUN_EXCHANGE_UPGRADE]: boolean;
}

/**
 * Proof and capacity bound to this listener by host composition.
 * Enable only in tests until session revocation enforces one live connection per run identity.
 */
export interface BunExchangeUpgradeOptions {
  /** True only for a listener the composition configured with native TLS. */
  readonly directTls?: true;
  /**
   * Host verifier for an explicitly protected ingress.
   * The host must establish encrypted peer transport for this upgrade through the protected ingress.
   */
  readonly verifyIngress?: (request: Request) => boolean;
  /** Reads admission capacity from this listener's transport before native upgrade. */
  readonly hasPendingCapacity: () => boolean;
}

/**
 * Minimal Bun server capability needed to upgrade an HTTP request to a
 * WebSocket connection.
 */
export interface BunRouteGraphUpgradeServer {
  /**
   * Upgrade a request to the native Bun WebSocket handler.
   * @param request - Incoming HTTP request.
   * @returns `true` when Bun accepted the upgrade.
   */
  upgrade(request: Request): boolean;
  /**
   * Upgrade an exchange connection, preserving the host-private evidence.
   * @param request - Incoming HTTP request.
   * @param data - Evidence to attach to the new socket.
   * @returns `true` when Bun accepted the upgrade.
   */
  upgradeExchange?(request: Request, data: BunExchangeUpgradeData): boolean;
}

/**
 * Fetch handler shape accepted by `Bun.serve` for a route-graph backed server.
 */
export type BunRouteGraphFetch = (
  request: Request,
  server: BunRouteGraphUpgradeServer,
) => Response | Promise<Response> | undefined | Promise<undefined>;

/**
 * Determine whether a request should be claimed by the Bun bus WebSocket
 * transport before it reaches the route graph.
 * @param request - Incoming HTTP request.
 * @returns `true` for canonical `/bus` upgrades and pathless non-browser LAN upgrades.
 */
function isBusWebSocketUpgrade(request: Request): boolean {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return false;
  }

  const { pathname } = new URL(request.url);
  if (pathname === '/bus') {
    return true;
  }

  return pathname === '/' && request.headers.get('origin') === null;
}

/**
 * Create the Bun fetch facade for a route graph plus native WebSocket server.
 *
 * Bun's `websocket` handlers are invoked only after the fetch handler calls
 * `server.upgrade(request)`. This wrapper keeps that infrastructure concern at
 * the Bun platform boundary while all non-WebSocket HTTP requests continue to
 * flow through the stable {@link HonoRouteGraph.fetch} facade.
 *
 * For boot's `workerExchangeTest` option, use `serveBunWorkerExchangeTest`.
 * It supplies the exchange policy here and installs both native handlers on
 * the server that boot checks.
 * @param routeGraph - Stable route graph facade for HTTP requests.
 * @param exchange - Evidence policy tied to this specific listener by the composition.
 * @returns Bun-compatible fetch function that upgrades bus WebSocket requests.
 */
export function createBunRouteGraphFetch(
  routeGraph: HonoRouteGraph,
  exchange?: BunExchangeUpgradeOptions,
): BunRouteGraphFetch {
  return (request, server) => {
    const exchangeUpgrade =
      exchange !== undefined &&
      request.headers.get('upgrade')?.toLowerCase() === 'websocket' &&
      new URL(request.url).pathname === CONNECTION_EXCHANGE_PATH;
    if (exchangeUpgrade && !exchange.hasPendingCapacity()) {
      return new Response(null, { status: 503 });
    }
    if (exchangeUpgrade || isBusWebSocketUpgrade(request)) {
      const upgraded = exchangeUpgrade
        ? server.upgradeExchange?.(request, {
            [BUN_EXCHANGE_UPGRADE]:
              exchange.directTls === true || verifyConnectionExchangeIngress(request, exchange.verifyIngress),
          })
        : server.upgrade(request);
      if (upgraded) {
        return undefined;
      }

      return new Response('WebSocket upgrade failed', {
        status: 426,
        headers: { Upgrade: 'websocket' },
      });
    }

    return routeGraph.fetch(request);
  };
}
