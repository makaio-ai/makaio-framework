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
import {
  handleCorrelationResponse,
  type BusMessage,
  type BusReceiveHandler,
  type CorrelationTracker,
} from '@makaio/bus-core';
import type { TransportReceiveContext } from '@makaio/core';

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
  readonly handlers: Set<BusReceiveHandler>;
  /**
   * Called when a `subscribe-sync-complete` message is received, resolving the
   * transport's `ready` promise for the current session.
   */
  onSyncComplete(): void;
  /**
   * Called when a dynamic subscription acknowledgement is received.
   * @param ackId - Acknowledgement identifier from the wire message.
   */
  onSubscriptionAck(ackId: string): void;
  /**
   * Send an acknowledgement for an inbound dynamic subscription update after
   * application handlers have applied it to local routing state.
   * @param ackId - Acknowledgement identifier from the inbound control frame.
   */
  sendSubscriptionAck(ackId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Fan out a decoded message to registered handlers and report aggregate success.
 * @param message - Decoded bus message
 * @param handlers - Registered message handlers
 * @param options - Logging options and receive context
 * @returns True when every handler completed successfully
 */
async function dispatchToHandlers(
  message: BusMessage,
  handlers: Set<BusReceiveHandler>,
  options: {
    debug: boolean;
    name: string;
    receiveContext?: TransportReceiveContext;
  },
): Promise<boolean> {
  const handlerResults = await Promise.allSettled(
    Array.from(handlers).map((handler) => handler(message, options.receiveContext)),
  );
  for (const result of handlerResults) {
    if (result.status === 'rejected' && options.debug) {
      console.error(`[WebSocketClientTransport:${options.name}] Handler error:`, result.reason);
    }
  }

  return handlerResults.every((result) => result.status === 'fulfilled');
}

/**
 * Build the receive context passed to bus handlers.
 * @param name - Transport name used for diagnostics.
 * @param auth - Optional auth strategy that may expose peer identity.
 * @returns Receive context for handlers invoked by this transport.
 */
function buildReceiveContext(name: string, auth: TransportAuth | undefined): TransportReceiveContext {
  return {
    ...auth?.getReceiveContext?.(),
    transportName: name,
  };
}

/**
 * Process the correlation phase of a single raw inbound frame.
 *
 * Runs the fast, transport-owned pipeline steps and returns once the
 * correlation tracker has been notified (or the frame was identified as a
 * control/heartbeat frame). Application handler dispatch is intentionally
 * excluded so that a stuck handler cannot block
 * `drainAndRejectPendingCorrelations`.
 *
 * Pipeline (correlation phase — steps 1–8):
 * 1. Parse JSON → validate shape
 * 2. Route pre-auth frames to `auth.handleAuthMessage`
 * 3. Filter raw heartbeats before decoding
 * 4. Decode with codec, apply optional transform
 * 5. Filter decoded heartbeats
 * 6. Resolve subscribe-sync-complete
 * 7. Resolve subscription-ack
 * 8. Handle correlation responses
 * @param data - Raw message data received from the WebSocket
 * @param deps - Handler dependencies
 * @returns The decoded message if it requires application handler dispatch,
 *   or `null` if the frame was fully handled as a control/correlation message.
 */
async function processCorrelationFrame(
  data: string | Buffer,
  deps: InboundMessageHandlerDeps,
): Promise<BusMessage | null> {
  const { name, debug, auth, codec, messageTransform, correlations } = deps;

  const parsed: unknown = JSON.parse(data.toString());

  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).type !== 'string') {
    if (debug) {
      console.error(`[WebSocketClientTransport:${name}] Invalid message structure:`, parsed);
    }
    return null;
  }

  const message = parsed as BusMessage;

  // Auth protocol frames are reserved for the auth layer for the full socket
  // lifetime; late duplicates must not leak into the bus codec/handlers.
  if (auth?.handleAuthMessage(message)) {
    return null;
  }

  // Filter raw heartbeats before any decoding/transform.
  if (message.type === 'heartbeat') {
    return null;
  }

  let decoded = await codec.decode(message);

  if (messageTransform) {
    decoded = await messageTransform(decoded);
  }

  if (decoded.type === 'heartbeat') {
    return null;
  }

  // Resolve the ready promise when the bus signals that initial subscribe
  // synchronization is complete. Not forwarded to application handlers.
  if (decoded.type === 'subscribe-sync-complete') {
    deps.onSyncComplete();
    return null;
  }

  if (decoded.type === 'subscription-ack') {
    if (typeof decoded.ackId === 'string') {
      deps.onSubscriptionAck(decoded.ackId);
    }
    return null;
  }

  if (handleCorrelationResponse(decoded, correlations)) {
    return null;
  }

  // Not a control or correlation frame — caller must dispatch to handlers.
  return decoded;
}

/**
 * Process a single raw inbound frame from the WebSocket.
 *
 * The pipeline is split into two phases:
 *
 * **Correlation phase** (`processCorrelationFrame`, steps 1–8):
 * Runs synchronously-fast transport steps (parse, auth, heartbeat filter,
 * codec decode, transform, sync-complete, correlation response). The promise
 * returned by this function settles as soon as the correlation phase is done.
 * `attachMessageListener` tracks this promise in `inFlightMessages` so that
 * `drainAndRejectPendingCorrelations` can await it without being blocked by
 * application handlers.
 *
 * **Dispatch phase** (step 9):
 * `dispatchToHandlers` is called fire-and-forget after the correlation phase
 * resolves, matching the original behaviour — a stuck handler does NOT block
 * reconnect or correlation drain.
 * @param data - Raw message data received from the WebSocket
 * @param deps - Handler dependencies
 */
export async function handleInboundMessage(data: string | Buffer, deps: InboundMessageHandlerDeps): Promise<void> {
  const { name, debug, auth, handlers } = deps;

  let decoded: BusMessage | null = null;
  try {
    decoded = await processCorrelationFrame(data, deps);
  } catch (error) {
    if (debug) {
      console.error(`[WebSocketClientTransport:${name}] Failed to parse message:`, error);
    }
    return;
  }

  if (decoded === null) {
    // Fully handled as control/correlation frame — nothing more to do.
    return;
  }

  // Application handler dispatch runs fire-and-forget so that a stuck handler
  // does not block the caller's inFlightMessages tracking (which only awaits
  // the promise returned by handleInboundMessage, i.e. the correlation phase).
  const receiveContext = buildReceiveContext(name, auth);
  const message = decoded;
  void dispatchToHandlers(message, handlers, { debug, name, receiveContext })
    .then(async (handlersApplied) => {
      if (
        handlersApplied &&
        (message.type === 'subscribe' || message.type === 'unsubscribe') &&
        typeof message.ackId === 'string'
      ) {
        await deps.sendSubscriptionAck(message.ackId);
      }
    })
    .catch((error) => {
      if (debug) {
        console.error(`[WebSocketClientTransport:${name}] Handler dispatch error:`, error);
      }
    });
}
