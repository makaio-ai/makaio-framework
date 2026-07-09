/**
 * Configuration types and defaults for `WebSocketClientTransport`.
 *
 * Kept separate so the main transport module stays focused on the
 * `BusTransport` contract and lifecycle orchestration.
 */

import type { WebSocketLike, TransportAuth, ClientTransportCodec } from './types.js';
import type { BusMessage } from '@makaio/bus-core';
import { DEFAULT_AUTO_RECONNECT, type WebSocketClientTransportReconnectOptions } from './ws-client-reconnect.js';

export type { WebSocketClientTransportReconnectOptions } from './ws-client-reconnect.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration options for `WebSocketClientTransport`.
 */
export interface WebSocketClientTransportOptions {
  /**
   * WebSocket server URL.
   *
   * The transport creates and recreates the WebSocket internally — callers
   * never pass a `WebSocket` instance directly.
   * @example 'ws://localhost:8080/bus'
   */
  url: string;

  /**
   * Transport identity used for registration in the bus transport registry.
   * @defaultValue 'ws-client'
   */
  name?: string;

  /**
   * Authentication strategy for HMAC or E2E handshakes.
   */
  auth?: TransportAuth;

  /**
   * Wire codec for encryption or custom framing.
   *
   * Defaults to a plain JSON codec with no transformation.
   */
  codec?: ClientTransportCodec;

  /**
   * Optional async transform applied to every incoming message after codec
   * decoding, before correlation tracking and handler dispatch.
   *
   * Use this to inject E2E decryption or message normalization.
   * @param message - Decoded bus message from the wire
   * @returns Transformed message (may be the same reference if unchanged)
   */
  messageTransform?: (message: BusMessage) => Promise<BusMessage>;

  /**
   * Automatic reconnection configuration. Defaults to exponential backoff
   * starting at 1 s and capped at 10 s. Pass `false` to disable automatic
   * reconnection.
   *
   * Note: this configures the reconnection *policy* and is distinct from the
   * imperative {@link WebSocketClientTransport.reconnect} method, which triggers
   * an immediate reconnect attempt.
   * @defaultValue `{ baseMs: 1000, maxMs: 10000 }`
   */
  autoReconnect?: WebSocketClientTransportReconnectOptions | false;

  /**
   * Maximum time in milliseconds a single connect attempt may wait for the
   * socket to open before the attempt is failed and the socket discarded.
   *
   * Bounds the WebSocket upgrade so a server (or intermediary) that accepts
   * the TCP connection but never answers cannot wedge the reconnect loop.
   * Also passed as `handshakeTimeout` to the default `ws` factory.
   * @defaultValue 30000
   */
  connectTimeoutMs?: number;

  /**
   * WebSocket constructor factory.
   *
   * Defaults to the `ws` package's `WebSocket` loaded via dynamic import.
   * Override this to provide a browser `WebSocket`, a mock for testing, or any
   * other `WebSocketLike` implementation. The factory may be async so that
   * callers can defer module loading until the first connection attempt.
   * @param url - WebSocket server URL
   * @returns A `WebSocketLike` instance (not yet opened), or a Promise thereof
   */
  createWebSocket?: (url: string) => WebSocketLike | Promise<WebSocketLike>;

  /**
   * Called each time the transport establishes a connection (initial or reconnect).
   *
   * Fired after the socket is open, authentication is complete, and subscriptions
   * have been replayed. Use this to trigger application-level reconnect recovery.
   */
  onConnected?: () => void;

  /**
   * Called each time the transport loses its connection.
   *
   * Fired when the socket closes unexpectedly (not on a clean `disconnect()` call).
   * Use this to activate application-level disconnect recovery logic.
   */
  onDisconnected?: () => void;

  /**
   * Enable verbose debug logging to the console.
   * @defaultValue false
   */
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default bound for a single connect attempt's socket-open wait.
 *
 * Applied when {@link WebSocketClientTransportOptions.connectTimeoutMs} is
 * not supplied.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Plain JSON codec applied when no `codec` option is supplied.
 *
 * Encodes messages as JSON strings and decodes raw objects back to
 * `BusMessage` with no transformation.
 */
export const DEFAULT_CODEC: ClientTransportCodec = {
  encode: async (message) => JSON.stringify(message),
  decode: async (message) => message as BusMessage,
};

/**
 * Resolve the auto-reconnect configuration from user-supplied options.
 *
 * Returns `false` when auto-reconnect is disabled, or a fully-populated
 * `Required<WebSocketClientTransportReconnectOptions>` otherwise.
 * @param autoReconnect - Raw `autoReconnect` value from `WebSocketClientTransportOptions`
 * @returns Resolved reconnect config or `false`
 */
export function resolveReconnectConfig(
  autoReconnect: WebSocketClientTransportReconnectOptions | false | undefined,
): Required<WebSocketClientTransportReconnectOptions> | false {
  if (autoReconnect === false) {
    return false;
  }
  return {
    baseMs: autoReconnect?.baseMs ?? DEFAULT_AUTO_RECONNECT.baseMs,
    maxMs: autoReconnect?.maxMs ?? DEFAULT_AUTO_RECONNECT.maxMs,
  };
}
