/**
 * Hono WebSocket bridge for {@link ServerTransport}.
 *
 * This module provides a shim that allows Hono's per-route WebSocket upgrade
 * handling to feed into {@link ServerTransport}'s {@link WebSocketServerLike}
 * connection listener interface without requiring a real `ws.WebSocketServer`.
 */

import type { WebSocketServerLike, WebSocketLike } from '@makaio/bus-transport-websocket';

/** Union of all listener signatures accepted by {@link WebSocketServerLike}. */
type ServerEventListener = ((socket: WebSocketLike) => void) | ((error: Error) => void) | (() => void);

/**
 * Bridges Hono's per-route WebSocket handling to {@link ServerTransport}'s
 * {@link WebSocketServerLike} connection listener interface.
 *
 * Instead of owning a real WebSocket server, this shim receives already-upgraded
 * sockets from Hono's `upgradeWebSocket` handler and forwards them to
 * `ServerTransport` as if they came from a `wss.on('connection')` event.
 * @example
 * ```typescript
 * const bridge = new HonoWebSocketBridge();
 * const busServer = createBusServer({ websocket: bridge, auth, debug });
 * await busServer.start();
 *
 * app.get('/bus', upgradeWebSocket(() => ({
 *   onOpen(_event, ws) {
 *     bridge.accept(ws.raw as WebSocketLike);
 *   },
 * })));
 * ```
 */
export class HonoWebSocketBridge implements WebSocketServerLike {
  private readonly connectionListeners = new Set<(socket: WebSocketLike) => void>();

  /**
   * Register an event listener.
   *
   * Only `'connection'` listeners are tracked; `'error'` and `'close'` are
   * accepted for interface compatibility but are no-ops on this shim.
   * @param event - Event type
   * @param listener - Listener to register
   */
  public on(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  public on(event: 'error', listener: (error: Error) => void): void;
  public on(event: 'close', listener: () => void): void;
  public on(event: string, listener: ServerEventListener): void {
    if (event === 'connection') {
      this.connectionListeners.add(listener as (socket: WebSocketLike) => void);
    }
  }

  /**
   * Remove a previously registered event listener.
   *
   * Only `'connection'` listeners are tracked; `'error'` and `'close'` are
   * accepted for interface compatibility but are no-ops on this shim.
   * @param event - Event type
   * @param listener - Listener to remove
   */
  public off(event: 'connection', listener: (socket: WebSocketLike) => void): void;
  public off(event: 'error', listener: (error: Error) => void): void;
  public off(event: 'close', listener: () => void): void;
  public off(event: string, listener: ServerEventListener): void {
    if (event === 'connection') {
      this.connectionListeners.delete(listener as (socket: WebSocketLike) => void);
    }
  }

  /**
   * Clear all connection listeners (called by {@link ServerTransport} on disconnect).
   * @param cb - Optional callback invoked after cleanup
   */
  public close(cb?: (err?: Error) => void): void {
    this.connectionListeners.clear();
    cb?.();
  }

  /**
   * Feed an already-upgraded WebSocket into the transport layer.
   *
   * Called from Hono's `upgradeWebSocket` `onOpen` handler with `ws.raw`
   * cast to {@link WebSocketLike}.
   * @param socket - The raw WebSocket from Hono's WSContext
   */
  public accept(socket: WebSocketLike): void {
    for (const listener of this.connectionListeners) {
      listener(socket);
    }
  }
}
