/**
 * Minimal Bun.serve() type declaration for the Electrobun composition root.
 *
 * The `Bun` global is provided by the Bun runtime. We only declare the
 * `Bun.serve()` surface actually used by this composition root to avoid
 * importing the full `@types/bun` package, which overrides global web API
 * types (`ReadableStream`, `fetch`, etc.) in ways that break other packages
 * compiled in the same TypeScript project.
 */

/**
 * Return value of {@link Bun.serve} after the server is bound.
 */
declare interface BunServeResult {
  /** TCP port the server is bound to. Always set after `Bun.serve()` resolves. */
  readonly port: number;
  /** Hostname the server is bound to (e.g. `'127.0.0.1'`). */
  readonly hostname: string;
  /** Stop accepting new connections. */
  stop(closeActiveConnections?: boolean): void;
}

/**
 * Opaque WebSocket handler type for `Bun.serve({ websocket })`.
 *
 * Typed as `object` so any concrete handler (e.g. the one returned by
 * {@link BunBusServerTransportProvider.createWebSocketHandler}) is assignable
 * without importing Bun-specific types into this shim.
 */
declare type BunServeWebSocketHandler = object;

/**
 * Minimal server handle passed by Bun to the `fetch` callback.
 */
declare interface BunServeRequestServer {
  /**
   * Upgrade an HTTP request to a WebSocket connection handled by the
   * configured `websocket` callbacks.
   * @param req - Incoming request.
   * @returns `true` when the upgrade was accepted.
   */
  upgrade(req: Request): boolean;
}

/**
 * Server creation options accepted by {@link Bun.serve}.
 */
declare interface BunServeOptions {
  /** Request handler for all HTTP requests. */
  fetch(req: Request, server: BunServeRequestServer): Response | Promise<Response> | undefined | Promise<undefined>;
  /** WebSocket handler passed to the Bun server (e.g. from the bus transport). */
  websocket?: BunServeWebSocketHandler;
  /** TCP port to bind to. Defaults to an OS-assigned port if omitted. */
  port?: number;
  /** Hostname to bind to. Defaults to `'0.0.0.0'` if omitted. */
  hostname?: string;
}

/**
 * Bun global namespace — limited to the `serve()` function.
 */
declare const Bun: {
  /**
   * Start an HTTP server.
   * @param options - Server configuration.
   * @returns Running server handle.
   */
  serve(options: BunServeOptions): BunServeResult;
};
