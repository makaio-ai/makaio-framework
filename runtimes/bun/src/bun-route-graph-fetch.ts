import type { HonoRouteGraph } from '@makaio/runtime-node';

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
 * @param routeGraph - Stable route graph facade for HTTP requests.
 * @returns Bun-compatible fetch function that upgrades bus WebSocket requests.
 */
export function createBunRouteGraphFetch(routeGraph: HonoRouteGraph): BunRouteGraphFetch {
  return (request, server) => {
    if (isBusWebSocketUpgrade(request)) {
      if (server.upgrade(request)) {
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
