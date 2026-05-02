/**
 * Inbound message dispatch for the server-mode WebSocket transport.
 *
 * Provides a factory that creates per-socket message handlers. Keeping this
 * logic separate from `ServerTransport` allows the transport class to focus on
 * connection lifecycle and the `BusTransport` contract while message routing
 * stays in one cohesive place.
 */

import type {
  BusBroadcastMessage,
  BusBroadcastResponseMessage,
  BusMessage,
  BusReceiveHandler,
  BusResponseMessage,
  BusSubscribeMessage,
  BusUnsubscribeMessage,
  CorrelationTracker,
} from '@makaio/bus-core';
import { deserializeTransportError } from '@makaio/bus-core';
import type { TransportAuth, WebSocketLike } from './types.js';
import type { BroadcastAggregator } from './broadcast-aggregator.js';
import type { ClientRegistry } from './client-registry.js';
import type { TransportReceiveContext } from '@makaio/core';

/**
 * Dependencies injected into each per-socket message handler.
 */
export interface MessageHandlerDeps {
  /** Per-client routing and subscription state. */
  registry: ClientRegistry;
  /** Correlation tracker for server-initiated request/response pairs. */
  correlations: CorrelationTracker;
  /** Broadcast aggregation for both client- and server-initiated broadcasts. */
  broadcastAggregator: BroadcastAggregator;
  /** Registered bus handlers that receive inbound messages. */
  handlers: Set<BusReceiveHandler>;
  /** Optional authentication strategy. */
  auth: TransportAuth | undefined;
  /** Normalized broadcast timeout in milliseconds. */
  normalizeBroadcastTimeout: (timeout: unknown) => number;
  /** Safe send callback: delivers serialized data to one client without propagating socket errors. */
  sendSafely: (client: WebSocketLike, data: string) => void;
  /** Enable debug logging. */
  debug: boolean;
}

/**
 * Invoke all registered bus handlers for a message, swallowing per-handler errors.
 *
 * Handler errors are swallowed to keep propagation best-effort.
 * @param message - Bus message to dispatch
 * @param handlers - Set of registered bus handlers
 * @param options - Dispatch options
 */
async function invokeHandlers(
  message: BusMessage,
  handlers: Set<BusReceiveHandler>,
  options: {
    debug: boolean;
    receiveContext?: TransportReceiveContext;
    logContext?: string;
  },
): Promise<void> {
  await Promise.all(
    Array.from(handlers).map(async (handler) => {
      try {
        await handler(message, options.receiveContext);
      } catch (error) {
        if (options.debug) {
          const suffix = options.logContext ? ` ${options.logContext}` : '';
          console.error(`[ServerTransport] Handler error${suffix}:`, error);
        }
      }
    }),
  );
}

/**
 * Check whether `value` is a non-null, non-array plain object (wire-format
 * record). Used to validate subscription subject maps before touching registry state.
 * @param value - Value to check
 * @returns True when `value` is a plain object suitable for a subjects record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Handle response/correlation messages that do not need receive context.
 * @param message - Inbound bus message
 * @param deps - Handler dependencies
 * @param socket - The originating client socket
 * @returns `true` when the message was handled and no further processing is needed
 */
function handleCorrelationMessage(message: BusMessage, deps: MessageHandlerDeps, socket: WebSocketLike): boolean {
  const { correlations, broadcastAggregator, debug } = deps;

  if (message.type === 'heartbeat') return true;

  if (message.type === 'response') {
    const response = message as BusResponseMessage;
    if (typeof response.correlationId !== 'string') {
      if (debug) console.warn('[ServerTransport] Malformed response message: missing correlationId');
      return true;
    }
    if (response.error) {
      correlations.reject(response.correlationId, deserializeTransportError(response.error));
    } else {
      correlations.resolve(response.correlationId, response.result);
    }
    return true;
  }

  if (message.type === 'broadcast-response') {
    const broadcastResp = message as BusBroadcastResponseMessage;
    if (typeof broadcastResp.correlationId !== 'string') {
      if (debug) console.warn('[ServerTransport] Malformed broadcast-response: missing correlationId');
      return true;
    }
    broadcastAggregator.handleResponse(socket, broadcastResp);
    return true;
  }

  return false;
}

/**
 * Route a parsed, authenticated bus message to the appropriate handler.
 *
 * Called after the auth gate and structural validation have passed.
 * Per-type shape checks guard each cast so malformed frames cannot corrupt
 * registry, correlation, or aggregation state.
 * @param message - Validated inbound bus message
 * @param socket - The originating client socket
 * @param deps - Handler dependencies
 * @internal Exported for unit testing only.
 */
export async function routeMessage(
  message: BusMessage,
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
): Promise<void> {
  const { registry, broadcastAggregator, handlers, normalizeBroadcastTimeout, sendSafely, debug } = deps;

  if (handleCorrelationMessage(message, deps, socket)) return;

  const receiveContext = deps.auth?.getReceiveContext?.(socket);

  // Handle subscription messages.
  // Track internally for client-level routing AND forward to bus handlers
  // so the transport registry can populate remoteRequestHandlers for
  // priority-based dispatch.
  if (message.type === 'subscribe') {
    if (!isRecord((message as BusSubscribeMessage).subjects)) {
      if (debug) console.warn('[ServerTransport] Malformed subscribe message: missing subjects record');
      return;
    }
    registry.handleSubscribeMessage(socket, message as BusSubscribeMessage);
    await invokeHandlers(message, handlers, { debug, receiveContext, logContext: 'dispatching subscribe' });
    return;
  }

  if (message.type === 'unsubscribe') {
    if (!isRecord((message as BusUnsubscribeMessage).subjects)) {
      if (debug) console.warn('[ServerTransport] Malformed unsubscribe message: missing subjects record');
      return;
    }
    registry.handleUnsubscribeMessage(socket, (message as BusUnsubscribeMessage).subjects);
    await invokeHandlers(message, handlers, { debug, receiveContext, logContext: 'dispatching unsubscribe' });
    return;
  }

  // Handle broadcast messages: forward to other clients AND invoke local handlers.
  // Both dispatches are required — local handlers trigger transport-registry processing.
  if (message.type === 'broadcast') {
    const broadcastMsg = message as BusBroadcastMessage;
    if (typeof broadcastMsg.correlationId !== 'string' || typeof broadcastMsg.subject !== 'string') {
      if (debug) console.warn('[ServerTransport] Malformed broadcast message: missing correlationId or subject');
      return;
    }
    const targetClients = registry.getInterestedClients(broadcastMsg.subject, broadcastMsg.payload, socket);
    const timeout = normalizeBroadcastTimeout(broadcastMsg.timeout);
    broadcastAggregator.startClientBroadcast(socket, broadcastMsg, targetClients, sendSafely, timeout);
    await invokeHandlers(message, handlers, { debug, receiveContext });
    return;
  }

  // Forward events from one client to other interested clients.
  // The transport registry relays events to OTHER transports but excludes
  // the source (ServerTransport) to prevent loops. Cross-client forwarding
  // within the same ServerTransport must happen here.
  if (message.type === 'event') {
    registry.forwardEventToClients(socket, message, sendSafely);
  }

  // Call all registered handlers in parallel.
  await invokeHandlers(message, handlers, { debug, receiveContext });
}

/**
 * Create the inbound message handler for a specific client socket.
 *
 * The returned async function is attached to the socket's `message` event.
 * It handles auth routing, subscription tracking, correlation resolution,
 * broadcast aggregation, cross-client event forwarding, and general handler
 * dispatch — in that precedence order.
 * @param socket - The client socket this handler belongs to
 * @param deps - Handler dependencies
 * @returns Async message handler function
 */
export function createInboundMessageHandler(
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
): (data: string | Buffer) => Promise<void> {
  const { auth, registry, debug } = deps;

  return async (data: string | Buffer): Promise<void> => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(data.toString());
    } catch (error) {
      if (debug) {
        console.error('[ServerTransport] Failed to parse message:', error);
      }
      return;
    }

    const candidate = parsed && typeof parsed === 'object' ? (parsed as { type?: unknown }) : undefined;

    if (!candidate || typeof candidate.type !== 'string') {
      if (debug) {
        console.error('[ServerTransport] Invalid message structure:', parsed);
      }
      return;
    }

    const message = parsed as BusMessage;

    try {
      // Always route auth messages to the auth handler (let it decide what to filter).
      if (auth?.handleAuthMessage(message, socket)) {
        return;
      }

      // Drop non-auth messages during the authentication phase.
      // The auth gate is safe because setupClientConnection (server-client-setup.ts)
      // calls registry.addAuthenticating(socket) BEFORE attaching the message listener,
      // so this check covers every inbound frame from first open to auth completion.
      if (auth && registry.isAuthenticating(socket)) {
        if (debug) {
          console.warn('[ServerTransport] Ignoring message from unauthenticated client');
        }
        return;
      }

      await routeMessage(message, socket, deps);
    } catch (error) {
      if (debug) {
        // Processing failures are logged separately from malformed JSON so
        // auth/routing defects are not hidden as wire-format problems.
        console.error('[ServerTransport] Failed to process message:', error);
      }
    }
  };
}
