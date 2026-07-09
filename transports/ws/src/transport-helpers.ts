/**
 * WebSocket-specific transport utilities.
 *
 * Only WebSocket-specific primitives live here. Generic helpers are owned by
 * `@makaio/bus-core` and imported directly by transport implementations.
 */

import type { BusMessage } from '@makaio/bus-core';
import type { ClientTransportCodec, WebSocketLike } from './types.js';

/**
 * Extract an error message from a WebSocket error event.
 *
 * Node `ws` fires `ErrorEvent` (has `.message`), browsers fire a plain `Event`
 * without it. This helper normalises both shapes into a string.
 * @param event - The error event from a WebSocket `error` listener
 * @param fallback - Fallback message when no `.message` property exists
 * @returns Human-readable error message
 */
export function extractSocketErrorMessage(event: Event, fallback = 'unknown error'): string {
  return 'message' in event ? String((event as ErrorEvent).message) : fallback;
}

/**
 * Encode a bus message with the provided codec and send it over the socket.
 *
 * This is the canonical encode+send primitive shared by both client transports.
 * The caller is responsible for readyState guards and buffering decisions —
 * this function unconditionally encodes and sends.
 * @param message - Bus message to encode and send
 * @param codec - Codec for encoding the message to the wire format
 * @param ws - Open WebSocket-like socket to send on
 */
export async function sendEncoded(message: BusMessage, codec: ClientTransportCodec, ws: WebSocketLike): Promise<void> {
  const payload = await codec.encode(message);
  ws.send(payload);
}

/**
 * Wait for a WebSocket to reach `readyState === 1` (OPEN).
 *
 * Resolves immediately when the socket is already open. Rejects if the
 * socket emits an `error` event or closes before opening (e.g. network drop
 * during the TCP handshake), or when `timeoutMs` elapses first — a server
 * that accepts the TCP connection but never answers the upgrade fires no
 * event at all, so the wait must be bounded. All listeners and the timer are
 * removed in every path so nothing leaks after the promise settles.
 * @param ws - WebSocket to wait on
 * @param timeoutMs - Maximum time to wait for the `open` event; omit for no bound
 * @returns Promise that resolves when the socket is open
 */
export function waitForSocketOpen(ws: WebSocketLike, timeoutMs?: number): Promise<void> {
  if (ws.readyState === 1) {
    return Promise.resolve();
  }
  // CLOSING (2) or CLOSED (3) — no future event will fire.
  if (ws.readyState >= 2) {
    return Promise.reject(new Error('WebSocket closed before opening'));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (event: Event): void => {
      cleanup();
      reject(new Error(`WebSocket connection failed — ${extractSocketErrorMessage(event)}`));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('WebSocket closed before opening'));
    };
    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            cleanup();
            reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : undefined;
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
  });
}
