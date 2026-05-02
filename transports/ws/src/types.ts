/**
 * Duck-typed WebSocket interfaces for transport abstraction.
 *
 * These interfaces allow the transport to work with any WebSocket-like
 * implementation without depending on specific libraries (ws, browser WebSocket, etc.)
 */

import type { BusMessage } from '@makaio/bus-core';
import type { TransportAuth } from './auth/index.js';

export type { TransportAuth };

/**
 * Transport-level close event shape.
 *
 * Browser `CloseEvent` is not available in every runtime that implements this
 * duck-typed WebSocket contract (for example Bun server handlers running under
 * Node-based test runners), but transport consumers only rely on the close
 * code and reason.
 */
export interface WebSocketCloseEvent extends Event {
  /**
   * WebSocket close status code.
   */
  readonly code: number;

  /**
   * Human-readable close reason.
   */
  readonly reason: string;
}

/**
 * Create a transport-level close event without depending on the browser-only
 * `CloseEvent` global.
 * @param code - WebSocket close code.
 * @param reason - Human-readable close reason.
 * @returns Portable close event for {@link WebSocketLike} listeners.
 */
export function createWebSocketCloseEvent(code?: number, reason?: string): WebSocketCloseEvent {
  const event = new Event('close') as Event & { code: number; reason: string };
  Object.defineProperties(event, {
    code: { value: code ?? 1000, enumerable: true },
    reason: { value: reason ?? '', enumerable: true },
  });
  return event as WebSocketCloseEvent;
}

/**
 * Client-side WebSocket interface.
 *
 * Compatible with browser WebSocket API and ws.WebSocket.
 */
export interface WebSocketLike {
  /**
   * Send data over the WebSocket connection.
   * @param data - Data to send (string, binary buffer, or Blob)
   */
  send(data: string | BufferSource | Blob): void;

  /**
   * Close the WebSocket connection.
   * @param code - Close code (optional)
   * @param reason - Close reason (optional)
   */
  close(code?: number, reason?: string): void;

  /**
   * Add an event listener.
   * @param event - Event type
   * @param listener - Event listener function
   */
  addEventListener(event: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(event: 'error', listener: (event: Event) => void): void;
  addEventListener(event: 'close', listener: (event: WebSocketCloseEvent) => void): void;
  addEventListener(event: 'open', listener: (event: Event) => void): void;

  /**
   * Remove an event listener.
   * @param event - Event type
   * @param listener - Event listener function
   */
  removeEventListener(event: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(event: 'error', listener: (event: Event) => void): void;
  removeEventListener(event: 'close', listener: (event: WebSocketCloseEvent) => void): void;
  removeEventListener(event: 'open', listener: (event: Event) => void): void;

  /**
   * Current connection state.
   */
  readonly readyState: number;
}

/**
 * Server-side WebSocketServer interface.
 *
 * Compatible with ws.WebSocketServer.
 */
export interface WebSocketServerLike {
  /**
   * Register a connection handler.
   * @param event - Event type
   * @param listener - Event listener function
   */
  on(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;

  /**
   * Remove an event listener.
   * @param event - Event type
   * @param listener - Event listener function
   */
  off(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  off(event: 'error', listener: (error: Error) => void): void;
  off(event: 'close', listener: () => void): void;

  /**
   * Close the WebSocket server.
   * @param callback - Callback when server is closed
   */
  close(callback?: (err?: Error) => void): void;
}

/**
 * WebSocket transport mode.
 */
export type WebSocketTransportMode = 'client' | 'server';

/**
 * Shared WebSocket transport configuration.
 */
export interface WebSocketTransportOptionsBase {
  /**
   * Optional authentication strategy.
   */
  auth?: TransportAuth;

  /**
   * Enable debug logging.
   */
  debug?: boolean;
}

/**
 * Client-mode WebSocket transport configuration.
 */
export interface WebSocketClientTransportOptions extends WebSocketTransportOptionsBase {
  /**
   * Transport mode: client.
   */
  mode: 'client';

  /**
   * WebSocket instance for client mode.
   */
  websocket: WebSocketLike;
}

/**
 * Server-mode WebSocket transport configuration.
 */
export interface WebSocketServerTransportOptions extends WebSocketTransportOptionsBase {
  /**
   * Transport mode: server.
   */
  mode: 'server';

  /**
   * WebSocketServer instance for server mode.
   */
  websocket: WebSocketServerLike;
}

/**
 * WebSocket transport configuration (discriminated union).
 */
export type WebSocketTransportOptions = WebSocketClientTransportOptions | WebSocketServerTransportOptions;

/**
 * Validate runtime input before narrowing to the discriminated union branches.
 *
 * The public factory is callable from untyped JavaScript, so it must reject
 * malformed mode/socket combinations explicitly instead of trusting TypeScript
 * to have enforced the contract at compile time.
 * @param options - Candidate transport options from runtime input
 * @throws TypeError when mode is missing/invalid or the socket shape does not
 *   satisfy the selected transport mode
 */
export function assertWebSocketTransportOptions(options: unknown): asserts options is WebSocketTransportOptions {
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('WebSocket transport options must be an object');
  }

  const candidate = options as { mode?: unknown; websocket?: unknown };
  if (candidate.mode !== 'client' && candidate.mode !== 'server') {
    throw new TypeError('WebSocket transport mode must be "client" or "server"');
  }

  if (candidate.mode === 'client') {
    if (!isClientWebSocketLike(candidate.websocket)) {
      throw new TypeError(
        'WebSocket transport client mode requires a websocket with addEventListener/removeEventListener',
      );
    }
    return;
  }

  if (!isServerWebSocketLike(candidate.websocket)) {
    throw new TypeError('WebSocket transport server mode requires a websocket with on/off listener methods');
  }
}

/**
 * Duck-type guard for client WebSocket instances.
 * @param websocket - Candidate socket
 * @returns True when the socket exposes browser/ws-style listener methods
 */
function isClientWebSocketLike(websocket: unknown): websocket is WebSocketLike {
  if (typeof websocket !== 'object' || websocket === null) {
    return false;
  }

  const candidate = websocket as Partial<WebSocketLike>;
  return (
    typeof candidate.send === 'function' &&
    typeof candidate.close === 'function' &&
    typeof candidate.addEventListener === 'function' &&
    typeof candidate.removeEventListener === 'function'
  );
}

/**
 * Duck-type guard for server WebSocket hosts.
 * @param websocket - Candidate socket server
 * @returns True when the host exposes ws.WebSocketServer-style listener methods
 */
function isServerWebSocketLike(websocket: unknown): websocket is WebSocketServerLike {
  if (typeof websocket !== 'object' || websocket === null) {
    return false;
  }

  const candidate = websocket as Partial<WebSocketServerLike>;
  return (
    typeof candidate.on === 'function' && typeof candidate.off === 'function' && typeof candidate.close === 'function'
  );
}

/**
 * Codec for encoding and decoding bus messages on the wire.
 *
 * Implement this interface to add transport-level encryption, custom framing,
 * or any other wire-format transformation. Both client transports
 * (`createClientTransport` and `WebSocketClientTransport`) accept an optional
 * codec and fall back to a plain JSON codec when none is provided.
 */
export interface ClientTransportCodec {
  /**
   * Encode a bus message for transmission.
   * @param message - Bus message to encode
   * @returns Encoded payload to send over the socket
   */
  encode(message: BusMessage): Promise<string | BufferSource>;
  /**
   * Decode a parsed wire message into a bus message.
   * @param message - Parsed message object
   * @returns Bus message
   */
  decode(message: unknown): Promise<BusMessage>;
}
