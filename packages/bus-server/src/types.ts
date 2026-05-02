/**
 * Types for the BusServer library.
 *
 * This library provides a framework-agnostic wrapper around the WebSocket
 * transport for server-side usage.
 */

import type { BusTransport, IMakaioBus } from '@makaio/bus-core';
import type { WebSocketServerLike, TransportAuth } from '@makaio/bus-transport-websocket';

/**
 * Configuration for creating a bus server instance.
 */
export interface BusServerConfig {
  /**
   * WebSocket server instance (e.g., from 'ws' package).
   */
  websocket: WebSocketServerLike;

  /**
   * Optional bus instance (defaults to global singleton).
   *
   * Useful for tests or custom contexts.
   */
  bus?: IMakaioBus;

  /**
   * Optional authentication provider for connection validation.
   */
  auth?: TransportAuth;

  /**
   * Enable debug logging.
   *
   * Defaults to false.
   */
  debug?: boolean;

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
 * Bus server instance with lifecycle management.
 *
 * Provides a clean API for starting/stopping the server and accessing
 * the underlying transport.
 */
export interface BusServer {
  /**
   * The underlying transport instance.
   *
   * Use this to access transport-specific functionality or for testing.
   */
  transport: BusTransport;

  /**
   * Start accepting WebSocket connections.
   *
   * This registers the transport with MakaioBus and begins listening
   * for client connections.
   * @throws Error if start is called when already started
   */
  start(): Promise<void>;

  /**
   * Stop accepting connections and disconnect all clients.
   *
   * This unregisters the transport from MakaioBus and closes all
   * active connections.
   */
  stop(): Promise<void>;

  /**
   * Get the current number of fully authenticated and connected clients.
   * @returns Number of connected clients
   */
  getConnectionCount(): number;
}
