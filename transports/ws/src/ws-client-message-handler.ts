/**
 * Inbound message handler for `WebSocketClientTransport`.
 *
 * Decodes raw WebSocket frames, routes auth messages to the auth layer,
 * filters heartbeats, resolves the subscribe-sync-complete handshake,
 * handles correlation responses, and fans out to application handlers.
 *
 * Kept separate so `ws-client-transport.ts` stays focused on lifecycle
 * orchestration and the `BusTransport` contract.
 */

import type { TransportAuth, ClientTransportCodec } from './types.js';
import { handleCorrelationResponse, type BusMessage, type CorrelationTracker } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into `handleInboundMessage`.
 *
 * All fields are read-only from the handler's perspective — the handler never
 * mutates them directly but may call their methods.
 */
export interface InboundMessageHandlerDeps {
  /**
   * Transport name used in debug log prefixes.
   */
  readonly name: string;
  /**
   * Whether verbose debug logging is enabled.
   */
  readonly debug: boolean;
  /**
   * Optional authentication strategy; handles pre-connect auth frames.
   */
  readonly auth: TransportAuth | undefined;
  /**
   * Codec used to decode wire frames into `BusMessage` objects.
   */
  readonly codec: ClientTransportCodec;
  /**
   * Optional async transform applied after codec decoding.
   */
  readonly messageTransform: ((message: BusMessage) => Promise<BusMessage>) | undefined;
  /**
   * Correlation tracker for resolving pending request/broadcast promises.
   */
  readonly correlations: CorrelationTracker;
  /**
   * Registered application-level message handlers.
   */
  readonly handlers: Set<(message: BusMessage) => Promise<void>>;
  /**
   * Called when a `subscribe-sync-complete` message is received, resolving the
   * transport's `ready` promise for the current session.
   */
  onSyncComplete(): void;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Process a single raw inbound frame from the WebSocket.
 *
 * Pipeline:
 * 1. Parse JSON → validate shape
 * 2. Route pre-auth frames to `auth.handleAuthMessage`
 * 3. Filter raw heartbeats before decoding
 * 4. Decode with codec, apply optional transform
 * 5. Filter decoded heartbeats
 * 6. Resolve subscribe-sync-complete
 * 7. Resolve correlation responses
 * 8. Fan out to application handlers
 * @param data - Raw message data received from the WebSocket
 * @param deps - Handler dependencies
 */
export async function handleInboundMessage(data: string | Buffer, deps: InboundMessageHandlerDeps): Promise<void> {
  const { name, debug, auth, codec, messageTransform, correlations, handlers } = deps;

  try {
    const parsed: unknown = JSON.parse(data.toString());

    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).type !== 'string') {
      if (debug) {
        console.error(`[WebSocketClientTransport:${name}] Invalid message structure:`, parsed);
      }
      return;
    }

    const message = parsed as BusMessage;

    // Auth protocol frames are reserved for the auth layer for the full socket
    // lifetime; late duplicates must not leak into the bus codec/handlers.
    if (auth?.handleAuthMessage(message)) {
      return;
    }

    // Filter raw heartbeats before any decoding/transform.
    if (message.type === 'heartbeat') {
      return;
    }

    let decoded = await codec.decode(message);

    if (messageTransform) {
      decoded = await messageTransform(decoded);
    }

    if (decoded.type === 'heartbeat') {
      return;
    }

    // Resolve the ready promise when the bus signals that initial subscribe
    // synchronization is complete. Not forwarded to application handlers.
    if (decoded.type === 'subscribe-sync-complete') {
      deps.onSyncComplete();
      return;
    }

    if (handleCorrelationResponse(decoded, correlations)) {
      return;
    }

    await Promise.all(
      Array.from(handlers).map(async (handler) => {
        try {
          await handler(decoded);
        } catch (error) {
          if (debug) {
            console.error(`[WebSocketClientTransport:${name}] Handler error:`, error);
          }
        }
      }),
    );
  } catch (error) {
    if (debug) {
      console.error(`[WebSocketClientTransport:${name}] Failed to parse message:`, error);
    }
  }
}
