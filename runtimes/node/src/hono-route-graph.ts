import type { Hono } from 'hono';

/**
 * Options for {@link createHonoRouteGraph}.
 *
 * Infrastructure routes handled by the stable facade rather than the
 * rebuildable Hono app are configured here so that a full graph rebuild
 * never accidentally removes them.
 */
export interface HonoRouteGraphOptions {
  /**
   * Health check callback. When provided, the facade intercepts
   * `GET /health` and returns a JSON response with the callback's return
   * value. When absent, `/health` falls through to the active Hono app.
   * @returns Any JSON-serialisable health snapshot.
   */
  health?: () => unknown;
}

/** Fetch facade for an atomically replaceable Hono route graph. */
export interface HonoRouteGraph {
  /**
   * Stable fetch function passed to the owning HTTP server.
   *
   * Before {@link markReady} it returns 503 without invoking Hono so the
   * mutable matcher is not built while boot is still registering routes.
   */
  readonly fetch: Hono['fetch'];
  /**
   * Allow HTTP requests to reach the active Hono app.
   */
  markReady(): void;
  /**
   * Swap future requests to a fully constructed Hono app.
   *
   * Existing requests keep using the app captured at dispatch time; new
   * requests observe the replacement immediately.
   * @param nextApp - Fully registered Hono app to serve for future requests.
   */
  replaceApp(nextApp: Hono): void;
}

/**
 * Create a stable HTTP-server fetch facade over an immutable-at-runtime Hono app.
 *
 * Hono route tables are mutable only until their matcher has handled a request.
 * Composition roots that bind the TCP server before runtime boot finishes must
 * keep early requests away from `app.fetch()`, then expose the app once all
 * boot-time routes are mounted. Dynamic route changes should build a fresh
 * Hono app off-path and call {@link HonoRouteGraph.replaceApp}.
 *
 * Infrastructure routes (`GET /health`, `GET /bus`) are handled by the stable
 * facade so they survive graph rebuilds and are never accidentally removed.
 * The `/bus` upgrade path returns 426 to signal that the endpoint requires a
 * WebSocket upgrade, replacing the former `registerBusHttpEndpoint` helper.
 * @param initialApp - Initial Hono app used after boot readiness.
 * @param options - Optional facade-level route configuration.
 * @returns Stable fetch facade plus readiness/replacement controls.
 */
export function createHonoRouteGraph(initialApp: Hono, options?: HonoRouteGraphOptions): HonoRouteGraph {
  let currentApp = initialApp;
  let ready = false;

  return {
    fetch: (request, env, executionContext) => {
      if (!ready) {
        return new Response('Makaio runtime is booting', {
          status: 503,
          headers: { 'Retry-After': '1' },
        });
      }

      const { pathname } = new URL(request.url);

      if (options?.health && request.method === 'GET' && pathname === '/health') {
        return Response.json(options.health());
      }

      if (request.method === 'GET' && pathname === '/bus') {
        return new Response('WebSocket endpoint', {
          status: 426,
          headers: { Upgrade: 'websocket' },
        });
      }

      const app = currentApp;
      return app.fetch(request, env, executionContext);
    },
    markReady() {
      ready = true;
    },
    replaceApp(nextApp) {
      currentApp = nextApp;
    },
  };
}
