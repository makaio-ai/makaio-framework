/**
 * Bus server initialization and lifecycle management.
 *
 * This module provides a high-level API for starting the bus server
 * with WebSocket transport, authentication, and adapter initialization.
 *
 * Uses the bus-server library for transport orchestration and MakaioBus integration.
 */

import { createBusServer } from './server.js';
import type { BusServer } from './types.js';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import type { TransportAuth, WebSocketServerLike } from '@makaio/bus-transport-websocket';
import type { IMakaioBus } from '@makaio/bus-core';

/**
 * Options for starting the bus server.
 */
export interface StartBusServerOptions {
  /**
   * WebSocket server instance.
   *
   * Accepts any {@link WebSocketServerLike} implementation, including the
   * concrete `ws.WebSocketServer` and {@link HonoWebSocketBridge}.
   */
  websocket: WebSocketServerLike;

  /**
   * Shared secret for HMAC authentication.
   *
   * Optional. When omitted and `auth` is not provided, no authentication is
   * enforced (dev mode). Ignored when `auth` is provided.
   * IMPORTANT: Use a strong secret in production.
   */
  secret?: string;

  /**
   * Custom auth strategy.
   *
   * When provided, bypasses the default HMAC auth creation from `secret`.
   * Use this to supply a `DispatchingAuth` (or any other `TransportAuth`)
   * when multiple auth protocols must be supported on a single port.
   */
  auth?: TransportAuth;

  /**
   * Enable debug logging.
   *
   * Defaults to false.
   */
  debug?: boolean;

  /**
   * Optional bus instance (defaults to global singleton).
   *
   * Use this when you have a runtime-specific bus instance.
   */
  bus?: IMakaioBus;

  /**
   * Registry name for the loopback relay transport.
   *
   * When set, a loopback transport is registered under this name alongside
   * the primary `'websocket'` transport. This enables cross-client relay:
   * when a WebSocket client sends a request, the relay excludes `'websocket'`
   * as the source but still reaches this loopback target, whose `send()`
   * routes the request to subscribed clients on the same server.
   */
  loopbackName?: string;
}

/**
 * Start the bus server with WebSocket transport.
 *
 * This function:
 * 1. Resolves the auth strategy: explicit `auth` option, then `secret`-based HMAC, then none
 * 2. Creates and starts the bus server
 * 3. Returns the server instance for lifecycle management
 *
 * NOTE: Adapters should be initialized separately via MakaioRuntime
 * before calling this function. The runtime handles adapter discovery,
 * loading, and registration with MakaioBus.
 * @param options - Server configuration options
 * @returns BusServer instance with start/stop/getConnectionCount methods
 * @throws Error if server startup fails
 * @example
 * ```typescript
 * import { WebSocketServer } from 'ws';
 * import { startBusServer } from '@makaio/bus-server/server-lifecycle';
 *
 * const wss = new WebSocketServer({ port: 3000 });
 * const busServer = await startBusServer({
 *   websocket: wss,
 *   secret: process.env.BUS_SECRET,
 *   debug: true,
 * });
 *
 * console.debug('Connected clients:', busServer.getConnectionCount());
 *
 * // Later...
 * await busServer.stop();
 * ```
 */
export async function startBusServer(options: StartBusServerOptions): Promise<BusServer> {
  const { websocket, secret, debug = false, bus, loopbackName } = options;

  try {
    // Resolve auth strategy: explicit `auth` takes precedence, then `secret` for HMAC,
    // then no auth (dev mode).
    const auth: TransportAuth | undefined = options.auth ?? (secret ? new HmacAuth({ secret }) : undefined);

    if (debug) {
      console.info('[startBusServer] Creating bus server...');
      if (!auth) {
        console.warn('[startBusServer] ⚠️  No authentication - dev mode only!');
      }
    }

    // Create bus server
    const busServer = createBusServer({
      websocket,
      auth,
      debug,
      bus,
      loopbackName,
    });

    // Start the server (connects transport, registers with MakaioBus)
    await busServer.start();

    if (debug) {
      console.info('[startBusServer] Bus server started');
    }

    return busServer;
  } catch (error) {
    console.error('[startBusServer] Failed to start bus server:', error);
    throw error;
  }
}
