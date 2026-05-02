/**
 * Client connection setup helpers for the server-mode WebSocket transport.
 *
 * Contains two concerns deliberately co-located:
 * - `normalizeClientBroadcastTimeout` — caps client-supplied timeouts so the
 *   server cannot be forced to retain pending aggregation state indefinitely.
 * - `setupClientConnection` — handles the full per-socket lifecycle: auth,
 *   subscription-sync, event listeners, and cleanup on close.
 * - `routeRequestToClients` — priority-ordered fan-out for server-initiated
 *   requests, retrying clients in descending priority until one responds.
 *
 * Keeping this logic out of `ServerTransport` lets the transport class focus on
 * the `BusTransport` contract while this module owns connection mechanics.
 */

import type { BusReceiveHandler, BusRequestMessage, CorrelationTracker } from '@makaio/bus-core';
import { NoHandlerError, TimeoutError, isNoHandlerErrorForSubject } from '@makaio/bus-core';
import type { TransportAuth, WebSocketLike } from './types.js';
import type { BroadcastAggregator } from './broadcast-aggregator.js';
import type { ClientRegistry } from './client-registry.js';
import { createInboundMessageHandler } from './server-message-handler.js';
import { buildSubscribeMessage, type SubscriptionEntry } from './subscribe-message.js';

const DEFAULT_CLIENT_BROADCAST_TIMEOUT_MS = 5_000;
const MAX_CLIENT_BROADCAST_TIMEOUT_MS = 60_000;

/**
 * Normalize a timeout supplied by a remote WebSocket client.
 *
 * Client-initiated broadcasts still need a server-owned retention cap: accepting
 * `0`, non-finite, negative, or arbitrarily large values would let a remote
 * peer keep pending aggregation state alive indefinitely.
 * @param timeout - Client-supplied broadcast timeout in milliseconds
 * @returns Bounded timeout in milliseconds for server-side aggregation
 */
export function normalizeClientBroadcastTimeout(timeout: unknown): number {
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    return DEFAULT_CLIENT_BROADCAST_TIMEOUT_MS;
  }
  return Math.min(timeout, MAX_CLIENT_BROADCAST_TIMEOUT_MS);
}

/**
 * Dependencies required by `setupClientConnection`.
 */
export interface ClientSetupDeps {
  /** Per-client routing and subscription state. */
  registry: ClientRegistry;
  /** Correlation tracker for server-initiated request/response pairs. */
  correlations: CorrelationTracker;
  /** Broadcast aggregation for client- and server-initiated broadcasts. */
  broadcastAggregator: BroadcastAggregator;
  /** Registered bus handlers that receive inbound messages. */
  handlers: Set<BusReceiveHandler>;
  /** Optional authentication strategy. */
  auth: TransportAuth | undefined;
  /**
   * Server-local handler subjects + priorities, replayed to each new client
   * so it can populate its `remoteRequestHandlers` before dispatching requests.
   * The function reads this map but never mutates it.
   */
  serverSubscriptions: Map<string, SubscriptionEntry>;
  /** Safe send callback: delivers serialized data to one client without propagating socket errors. */
  sendSafely: (client: WebSocketLike, data: string) => void;
  /** Enable debug logging. */
  debug: boolean;
}

/**
 * Set up a newly connected client socket: register event listeners, run
 * authentication, replay server subscriptions, and send the subscribe-sync-complete signal.
 *
 * When authentication is configured, `addAuthenticating` is called **before**
 * the message listener is attached so that every inbound frame — including the
 * very first one — passes through the auth gate in the message handler.
 * If authentication fails the socket is closed with code 1008, which triggers
 * the `close` listener and cleans up all resources.
 * @param socket - The newly accepted client WebSocket
 * @param deps - Shared server transport dependencies
 */
export async function setupClientConnection(socket: WebSocketLike, deps: ClientSetupDeps): Promise<void> {
  const { registry, correlations, broadcastAggregator, handlers, auth, serverSubscriptions, sendSafely, debug } = deps;

  // Mark the socket as authenticating BEFORE attaching the message listener so
  // that no inbound frame can bypass the auth gate in the message handler.
  if (auth) {
    registry.addAuthenticating(socket);
  }

  const messageHandler = createInboundMessageHandler(socket, {
    registry,
    correlations,
    broadcastAggregator,
    handlers,
    auth,
    normalizeBroadcastTimeout: normalizeClientBroadcastTimeout,
    sendSafely,
    debug,
  });

  const messageListener = (event: { data: string | Buffer }): void => {
    void messageHandler(event.data);
  };
  const closeListener = (): void => {
    auth?.cleanupSocket(socket);
    registry.removeClient(socket);
    socket.removeEventListener('message', messageListener);
    socket.removeEventListener('close', closeListener);
    socket.removeEventListener('error', errorListener);
    broadcastAggregator.handleClientDisconnect(socket);

    if (debug) {
      console.info(`[ServerTransport] Client disconnected (${registry.size} remaining)`);
    }
  };
  const errorListener = (event: unknown): void => {
    if (debug) {
      console.error('[ServerTransport] Client socket error:', event);
    }
  };

  socket.addEventListener('message', messageListener);
  socket.addEventListener('close', closeListener);
  socket.addEventListener('error', errorListener);

  try {
    if (auth) {
      await auth.authenticateServer(socket, (message: unknown) => {
        if (socket.readyState !== 1) {
          throw new Error(`Cannot send auth message: socket not ready (state: ${socket.readyState})`);
        }
        socket.send(JSON.stringify(message));
      });
      // Only remove from the auth-gated set after a successful handshake.
      // On failure the catch block closes the socket, and the close listener's
      // removeClient call clears authenticatingClients — keeping the socket
      // auth-gated until the connection is fully torn down.
      registry.removeAuthenticating(socket);
    }

    if (socket.readyState !== 1) {
      return;
    }

    registry.addClient(socket);

    // Replay server-local handler subscriptions so the client can populate
    // its remoteRequestHandlers for priority-based dispatch.
    if (serverSubscriptions.size > 0) {
      const initMessage = buildSubscribeMessage(serverSubscriptions);
      sendSafely(socket, JSON.stringify(initMessage));
    }

    // Signal that initial subscribe sync is complete. The client resolves its
    // ready promise upon receipt, unblocking priority-based request routing.
    sendSafely(socket, JSON.stringify({ type: 'subscribe-sync-complete' }));

    if (debug) {
      console.info(`[ServerTransport] Client connected (${registry.size} total)`);
    }
  } catch (error) {
    if (debug) {
      console.error('[ServerTransport] Client authentication failed:', error);
    }
    // Close socket — this will trigger closeListener which cleans up all resources.
    socket.close(1008, 'Authentication failed');
  }
}

/**
 * Dependencies required by `routeRequestToClients`.
 */
export interface RequestRoutingDeps {
  /** Per-client routing and subscription state. */
  registry: ClientRegistry;
  /** Correlation tracker for server-initiated request/response pairs. */
  correlations: CorrelationTracker;
}

/**
 * Send a server-initiated request to all connected clients in priority order,
 * retrying until one handles it.
 *
 * Routing is **unfiltered** — all connected clients are tried regardless of
 * their subscription state. This mirrors the transport registry's
 * `getRpcRelayTargets` design: subscriptions are eventually-consistent and
 * must not gate request correctness. Truly browser-local subjects are already
 * excluded via `$meta.local`.
 *
 * Each retry uses a unique correlation ID so stale responses or timeouts from
 * earlier attempts cannot settle the currently active attempt.
 * @param requestMsg - Request envelope
 * @param timeout - Correlation timeout in milliseconds
 * @param deps - Routing dependencies
 * @returns Request result from the first handling client
 * @throws NoHandlerError when no connected client handles the request
 */
export async function routeRequestToClients(
  requestMsg: BusRequestMessage,
  timeout: number,
  deps: RequestRoutingDeps,
): Promise<unknown> {
  const { registry, correlations } = deps;
  const fullSubject = `${requestMsg.namespace}.${requestMsg.subject}`;

  const readyClients = registry.getReadyClients();
  const prioritizedClients = readyClients
    .map((client) => ({
      client,
      priority: registry.getRequestRoutingPriority(client, fullSubject, requestMsg.payload),
    }))
    .sort((left, right) => right.priority - left.priority)
    .map(({ client }) => client);

  if (prioritizedClients.length === 0) {
    throw new NoHandlerError(fullSubject);
  }

  for (const [attemptIndex, targetClient] of prioritizedClients.entries()) {
    // Each retry must have a unique correlation ID so stale responses/timeouts
    // from earlier attempts cannot settle the currently active attempt.
    const attemptCorrelationId = `${requestMsg.correlationId}:attempt-${attemptIndex + 1}`;
    const requestForAttempt: BusRequestMessage = { ...requestMsg, correlationId: attemptCorrelationId };

    try {
      // send() can throw synchronously if the socket closed between
      // the readyState check in getReadyClients and now.
      targetClient.send(JSON.stringify(requestForAttempt));
    } catch {
      continue; // socket gone, try next client
    }

    try {
      return await correlations.track(attemptCorrelationId, timeout);
    } catch (error) {
      // Retry on errors that mean "this client did not handle the request":
      // - NoHandlerError: the client explicitly reported no handler.
      // - TimeoutError: the client was connected but did not respond in time.
      // Any other error (e.g. a handler ran and returned a failure) must
      // propagate immediately so the caller sees the real error.
      if (isNoHandlerErrorForSubject(error, fullSubject) || error instanceof TimeoutError) {
        continue;
      }
      throw error;
    }
  }

  throw new NoHandlerError(fullSubject);
}
