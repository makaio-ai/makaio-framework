import type { ICapabilityProvider } from '../../capability/types.js';

/**
 * Capability identifier for HTTP server providers.
 */
export const SERVER_CAPABILITY_ID = 'server' as const;

/**
 * Handler invoked when an HTTP connection requests a protocol upgrade.
 *
 * Follows the Node.js `http.Server` `upgrade` event signature so callers
 * can attach WebSocket or other protocol handlers without coupling to a
 * specific HTTP library.
 * @param request - The incoming HTTP request that triggered the upgrade.
 * @param socket - The raw network socket for the connection.
 * @param head - The first packet of the upgraded stream, buffered before
 *   the upgrade handler was attached.
 */
export type UpgradeHandler = (request: unknown, socket: unknown, head: unknown) => void;

/**
 * Address information returned by {@link HttpServerLike.address}.
 */
export interface ServerAddress {
  /** Bound port number. */
  readonly port: number;
}

/**
 * Minimal Node-compatible HTTP server interface for WebSocket upgrade handling
 * and port resolution.
 *
 * This contract models servers that expose Node's `upgrade` event. Bun's
 * native `Bun.Server` uses `server.upgrade(request)` from the fetch handler
 * instead, so Bun hosts should expose WebSocket routing through a Bun-specific
 * host seam rather than returning `Bun.Server` as `HttpServerLike`.
 */
export interface HttpServerLike {
  /**
   * Attach an event handler to the server.
   *
   * Only the `'upgrade'` event is required by this contract; implementors
   * may support additional events via overloads.
   * @param event - The event name to listen for.
   * @param handler - The handler to invoke when the event fires.
   */
  on(event: 'upgrade', handler: UpgradeHandler): void;

  /**
   * Remove a previously attached event handler from the server.
   *
   * Only the `'upgrade'` event is required by this contract.
   * @param event - The event name to remove the handler from.
   * @param handler - The handler to remove.
   */
  off(event: 'upgrade', handler: UpgradeHandler): void;

  /**
   * Return the bound address of the server.
   *
   * Returns `null` when the server is not yet listening. Returns a
   * {@link ServerAddress} when bound to a TCP port. The string case
   * (Unix domain socket) is not used by the relay but is included for
   * compatibility with Node.js `Server#address()` callers.
   * @returns Server address, pipe path string, or null
   */
  address(): ServerAddress | string | null;
}

/**
 * Capability provider that exposes a raw HTTP server for WebSocket upgrades.
 *
 * The composition root (host shell) registers an `IServerProvider` after
 * creating a Node-compatible HTTP server. Extensions that need to handle
 * WebSocket upgrade events query this capability from the bus and call
 * {@link getServer} to obtain the server handle.
 *
 * If no provider is registered (e.g. in a test kernel), consumers must
 * degrade gracefully.
 * @example
 * ```typescript
 * class NodeServerProvider implements IServerProvider {
 *   readonly id = 'node-server';
 *   readonly displayName = 'Node HTTP Server';
 *   readonly capabilityId = SERVER_CAPABILITY_ID;
 *
 *   constructor(private readonly server: HttpServerLike) {}
 *
 *   getServer(): HttpServerLike {
 *     return this.server;
 *   }
 * }
 * ```
 */
export interface IServerProvider extends ICapabilityProvider {
  /** Capability identifier — must be `'server'`. */
  readonly capabilityId: typeof SERVER_CAPABILITY_ID;

  /**
   * Return the underlying HTTP server for upgrade handling.
   * @returns The HTTP server instance.
   */
  getServer(): HttpServerLike;
}
