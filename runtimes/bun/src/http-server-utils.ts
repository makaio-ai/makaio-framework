/**
 * Minimal Bun server interface for port resolution.
 *
 * Duck-typed against `ReturnType<typeof Bun.serve>` — covers the address
 * properties used by this module without importing `bun-types`.
 */
export interface BunServer {
  /** The TCP port the server is listening on. */
  readonly port: number;
  /** The hostname the server is bound to (e.g. `'localhost'` or `'0.0.0.0'`). */
  readonly hostname: string;
  /**
   * Stop the server when the runtime owns the HTTP listener.
   * @param closeActiveConnections - Whether active connections should be closed.
   */
  stop?: (closeActiveConnections?: boolean) => void | Promise<void>;
}

/**
 * Resolve the bound TCP port from a Bun server.
 *
 * Unlike Node's `http.Server`, Bun's server exposes the port synchronously as
 * a plain property — no need to call `server.address()`.
 * @param server - Bun server instance returned by `Bun.serve()`.
 * @returns Numeric TCP port.
 */
export function resolveListeningPort(server: BunServer): number {
  return server.port;
}

/**
 * Bound address resolved from a Bun server instance.
 */
export interface BunServerAddress {
  /** Bound TCP port. */
  port: number;
  /** Bound host address (e.g. `'localhost'` or `'0.0.0.0'`). */
  host: string;
}

/**
 * Extract the bound host address and port from a Bun server.
 * @param server - Bun server instance returned by `Bun.serve()`.
 * @returns Object with `port` and `host` properties.
 */
export function resolveServerAddress(server: BunServer): BunServerAddress {
  return { port: server.port, host: server.hostname };
}
