/**
 * Client connection setup helpers for the server-mode WebSocket transport.
 *
 * Contains two concerns deliberately co-located:
 * - `normalizeClientBroadcastTimeout` — caps client-supplied timeouts so the
 *   server cannot be forced to retain pending aggregation state indefinitely.
 * - `setupClientConnection` — handles the full per-socket lifecycle: auth,
 *   subscription-sync, event listeners, and cleanup on close.
 * - `routeRequestToClients` — subscription-gated routing for server-initiated
 *   requests, moving on in connection order within one deadline only past
 *   clients that did not deliver the request to a terminal handler.
 *
 * Keeping this logic out of `ServerTransport` lets the transport class focus on
 * the `BusTransport` contract while this module owns connection mechanics.
 */

import type { ServerBoundaryAccess } from './server-boundary-access.js';
import type { BusReceiveHandler, BusRequestMessage, CorrelationTracker } from '@makaio/bus-core';
import {
  ConnectionLostError,
  NoHandlerError,
  TimeoutError,
  isNoHandlerErrorForSubject,
  isRequestCancellation,
} from '@makaio/bus-core';
import type { TransportAuth, WebSocketLike } from './types.js';
import type { BroadcastAggregator } from './broadcast-aggregator.js';
import type { ClientRegistry } from './client-registry.js';
import { createInboundMessageHandler, invokeSubscriptionUpdates } from './server-message-handler.js';
import { buildSubscribeMessage, type SubscriptionEntry } from './subscribe-message.js';
import { WebSocketConnectionError } from './connection-error.js';

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
  /** External subject policy for this server. */
  access?: ServerBoundaryAccess;
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
  sendSafely: (client: WebSocketLike, data: string) => boolean;
  /** Enable debug logging. */
  debug: boolean;
  /** Notify the owner after an authenticated connection is no longer routable. */
  onConnectionClosed: (connectionId: string) => void;
}

/**
 * Set up a newly connected client socket: register event listeners, run
 * authentication, replay server subscriptions, and send the subscribe-sync-complete signal.
 *
 * When authentication is configured, `addAuthenticating` is called **before**
 * the message listener is attached so that every inbound frame — including the
 * very first one — passes through the auth gate in the message handler.
 * Explicit authentication/policy refusals close with 1008; interruptions and
 * unclassified setup errors close with 1011. The close listener releases resources.
 * @param socket - The newly accepted client WebSocket
 * @param deps - Shared server transport dependencies
 */
// eslint-disable-next-line max-lines-per-function -- socket setup and close cleanup share one lifecycle boundary
export async function setupClientConnection(socket: WebSocketLike, deps: ClientSetupDeps): Promise<void> {
  const {
    registry,
    correlations,
    broadcastAggregator,
    handlers,
    auth,
    serverSubscriptions,
    sendSafely,
    onConnectionClosed,
  } = deps;
  const sensitive = auth?.hasSensitiveFrames?.(socket) ?? false;
  const debug = deps.debug && !sensitive;

  // Mark the socket as authenticating BEFORE attaching the message listener so
  // that no inbound frame can bypass the auth gate in the message handler.
  if (auth) {
    registry.addAuthenticating(socket);
  }

  const lifetime = new AbortController();
  const messageHandler = createInboundMessageHandler(
    socket,
    {
      registry,
      correlations,
      broadcastAggregator,
      handlers,
      auth,
      access: deps.access,
      normalizeBroadcastTimeout: normalizeClientBroadcastTimeout,
      sendSafely,
      debug,
    },
    lifetime.signal,
  );

  const messageListener = (event: { data: string | Buffer }): void => {
    if (!auth?.handleSetupFrame?.(event.data, socket)) void messageHandler(event.data);
  };
  const closeListener = (): void => {
    lifetime.abort();
    // Keep the authenticated owner before cleanup removes its socket context.
    const connectionId = auth?.getReceiveContext?.(socket)?.connectionId;
    auth?.cleanupSocket(socket);
    const subscriptionUpdates = registry.removeClient(socket);
    if (connectionId !== undefined) onConnectionClosed(connectionId);
    socket.removeEventListener('message', messageListener);
    socket.removeEventListener('close', closeListener);
    socket.removeEventListener('error', errorListener);
    correlations.rejectAll(new ConnectionLostError('websocket'));
    broadcastAggregator.handleClientDisconnect(socket);
    void invokeSubscriptionUpdates(subscriptionUpdates, handlers, {
      debug,
      logContext: 'dispatching disconnected client subscriptions',
    });

    if (debug) {
      console.info(`[ServerTransport] Client disconnected (${registry.size} remaining)`);
    }
  };
  const errorListener = (event: Event): void => {
    if (deps.debug) {
      console.error('[ServerTransport] Client socket error', socketDiagnostic(event, sensitive));
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
    }

    if (socket.readyState !== 1) {
      return;
    }

    const connectionId = completeClientAuthentication(auth, socket);
    registry.removeAuthenticating(socket);
    registry.addClient(socket, connectionId);

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
    if (deps.debug) {
      console.error('[ServerTransport] Client connection setup failed', socketDiagnostic(error, sensitive));
    }
    if (socket.readyState >= 2) return;
    // A timeout or unknown crypto/custom-auth failure is not evidence of a
    // policy refusal. Reserve 1008 for an explicitly classified rejection.
    const refused =
      error instanceof WebSocketConnectionError &&
      (error.code === 'WS_AUTHENTICATION_REJECTED' || error.code === 'WS_POLICY_REJECTED');
    socket.close(refused ? 1008 : 1011, refused ? 'Authentication failed' : 'Connection setup failed');
  }
}

/**
 * Project a transport failure into log fields without retaining the event or its cause.
 * @param failure - Socket error event or thrown setup failure.
 * @param sensitive - Omit diagnostic text throughout the exchange socket's lifetime.
 * @returns The permitted diagnostic fields for this socket.
 */
function socketDiagnostic(failure: unknown, sensitive: boolean) {
  const error =
    typeof failure === 'object' && failure !== null && 'error' in failure ? (failure.error ?? failure) : failure;
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  const details = {
    class: error instanceof Error ? error.constructor.name : 'Event',
    code: typeof code === 'number' || (typeof code === 'string' && /^\w+$/.test(code)) ? code : undefined,
  };
  if (sensitive || typeof error !== 'object' || error === null || !('message' in error)) return details;
  if (typeof error.message !== 'string') return details;
  const message = (error.message.split(/\r?\n/, 1)[0] ?? '')
    .replace(/\b(unknown identity\s+).*/i, '$1[redacted]')
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[redacted]')
    .replace(
      /\b(?:authorization|cookie|password|secret|token|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      '[redacted]',
    )
    .replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/gi, '[redacted]');
  return { ...details, message };
}

/**
 * Finalize authentication and retrieve its trusted route identifier in one turn.
 * @param auth - Server authentication policy, when configured.
 * @param socket - Open client socket awaiting registration.
 * @returns The authenticated connection ID, when available.
 */
function completeClientAuthentication(auth: TransportAuth | undefined, socket: WebSocketLike): string | undefined {
  auth?.completeServerAuthentication?.(socket);
  return auth?.getReceiveContext?.(socket)?.connectionId;
}

/**
 * Dependencies required by `routeRequestToClients`.
 */
export interface RequestRoutingDeps {
  /** External subject policy for client delivery. */
  access?: ServerBoundaryAccess;
  /** Per-client routing and subscription state. */
  registry: ClientRegistry;
  /** The tracker owned by the socket selected for this request attempt. */
  correlationsFor: (client: WebSocketLike) => CorrelationTracker | undefined;
  /** Caller cancellation: rejects the in-flight attempt and ends routing. */
  signal: AbortSignal;
}

/**
 * Send a server-initiated request to interested connected clients, moving on
 * in connection order only while a client did not deliver it to a handler.
 *
 * Routing considers only clients that advertised a matching request handler
 * and remain authorized for the request subject. A request received from a
 * client is never routed back to that origin socket.
 *
 * The request reaches the next client only when the previous attempt did not
 * deliver it to a terminal handler: the send failed or the client answered
 * that its handler chain was exhausted without a result. Any other outcome
 * ends routing — in particular a timeout, after which the client may still be
 * executing, and caller cancellation.
 *
 * Routing contract:
 * - All attempts share one deadline anchored from `timeout` when routing
 *   starts, so candidate lookup and serialization spend it too. Each attempt is
 *   sent and tracked with only the budget that remains, so no client gets a
 *   fresh budget.
 * - Candidate lookup (subscription-filter reads, authorization resolvers) and
 *   serialization (`toJSON`, getters) run caller code that can cancel the
 *   request or spend the budget. Every decision that follows such a phase is
 *   preceded by one checkpoint: cancellation first — the caller's own reason
 *   wins — then budget exhaustion, which is a `TimeoutError` for the request
 *   subject. Nothing is sent once either happened.
 * - A delivery decision spends the budget even when it denies a candidate.
 *   When there are no candidates or all attempts ended before the deadline,
 *   an exhausted route reports `NoHandlerError` after checking cancellation.
 *
 * Each attempt uses a unique correlation ID so stale responses from earlier
 * attempts cannot settle the currently active attempt.
 * @param requestMsg - Request envelope
 * @param timeout - Total routing budget in milliseconds; `0` means no automatic timeout
 * @param deps - Routing dependencies
 * @returns Request result from the first handling client
 * @throws NoHandlerError when no connected client handles the request
 * @throws TimeoutError when the budget is spent before a client answers
 */
export async function routeRequestToClients(
  requestMsg: BusRequestMessage,
  timeout: number,
  deps: RequestRoutingDeps,
): Promise<unknown> {
  const { registry, correlationsFor, signal } = deps;
  const fullSubject = `${requestMsg.namespace}.${requestMsg.subject}`;
  // One deadline for the whole routing, anchored before anything else runs: the
  // budget is measured from the moment the transport accepts the request, so
  // candidate lookup (subscription-filter reads, authorization resolvers) and
  // serialization spend it too, and a later attempt gets only what is left of
  // the caller's budget, never a fresh one. `timeout` is a finite number
  // >= 0, so `0` is the only unbounded value: the bus validates every budget
  // where it enters — `bus.request`/`bus.broadcast` reject an invalid one before
  // dispatching, and an invalid wire budget from a peer falls back to the
  // default — instead of each transport re-validating it.
  const deadline = timeout > 0 ? Date.now() + timeout : undefined;
  /**
   * Read what is left of the shared routing budget.
   * @returns Remaining milliseconds, or `0` — the tracker's no-timeout value — for an unbounded request
   * @throws TimeoutError once a bounded budget is spent
   */
  const remainingBudget = (): number => {
    if (deadline === undefined) return 0;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new TimeoutError(fullSubject, timeout);
    return remaining;
  };

  /**
   * The checkpoint that follows every phase running caller code: cancellation
   * first, so the caller's reason wins, then budget exhaustion.
   * @returns What is left of the budget, as `remainingBudget` reports it
   * @throws The caller's cancellation reason once the request was cancelled
   * @throws TimeoutError once a bounded budget is spent
   */
  const checkpoint = (): number => {
    signal.throwIfAborted();
    return remainingBudget();
  };

  const origin = registry.getRequestOrigin(requestMsg.correlationId);
  // Candidate lookup runs caller code; the checkpoint at the top of each attempt
  // follows it. An empty result has no attempt, so it falls through to the exit
  // below, which checks cancellation before classifying.
  const interestedClients = registry.getInterestedRequestClients(fullSubject, requestMsg.payload, origin);

  for (const targetClient of interestedClients) {
    checkpoint();
    if (deps.access) {
      const revalidate = await deps.access.authorizeDelivery(requestMsg, targetClient, () =>
        registry.matchesDelivery(targetClient, fullSubject, requestMsg.payload, 'handler'),
      );
      checkpoint();
      if (!revalidate?.()) continue;
    }
    // Each attempt must have a unique correlation ID so stale responses from
    // earlier attempts cannot settle the currently active attempt.
    const attemptCorrelationId = globalThis.crypto.randomUUID();
    // Serialized outside the send guard: an unserializable payload fails the
    // request for every client alike, it is not a lost socket. `timeout` is
    // left out here (an `undefined` value is not serialized) and appended below.
    const envelope = JSON.stringify({ ...requestMsg, correlationId: attemptCorrelationId, timeout: undefined });
    // After serialization, which runs caller code (`toJSON`, getters).
    const attemptBudget = checkpoint();
    // The wire `timeout` is the budget the receiver anchors its own deadline
    // from, so it is read after serialization — the same value the attempt is
    // tracked with — and appended as the frame's last field. `envelope` is a
    // non-empty JSON object, so replacing its closing brace keeps the frame
    // valid JSON.
    const frame = `${envelope.slice(0, -1)},"timeout":${attemptBudget}}`;

    const correlations = correlationsFor(targetClient);
    if (correlations === undefined || targetClient.readyState !== 1) continue;
    const response = correlations.track(attemptCorrelationId, attemptBudget, signal);
    try {
      targetClient.send(frame);
    } catch {
      // The frame did not leave; release the pending attempt before trying the next socket.
      correlations.cancel(attemptCorrelationId);
      await response.catch(() => undefined);
      continue;
    }

    try {
      return await response;
    } catch (error) {
      // The caller's own cancellation reaches it unchanged, before any
      // classification — even a reason shaped like a no-handler answer or a
      // timeout.
      if (isRequestCancellation(error, signal)) throw error;
      // A timeout leaves the outcome unknown, so it ends routing — the bus
      // never re-sends a request whose handler may already be running. Client
      // answers arrive as deserialized plain errors, so a TimeoutError here is
      // the tracker's attempt timer, which names the attempt correlation ID
      // and the remaining budget; the caller timed out on the request subject
      // after its whole budget.
      if (error instanceof TimeoutError) throw new TimeoutError(fullSubject, timeout);
      // Only an explicit no-handler answer lets the request move on: the
      // client's chain ended without a terminal handler producing a result.
      // Every other error propagates: a handler failure is the real result.
      // A cancellation that lands after a no-handler answer is caught by the
      // abort checks on the way to the next client or out of the loop.
      if (isNoHandlerErrorForSubject(error, fullSubject)) {
        continue;
      }
      throw error;
    }
  }

  // No client took the request and no decision or attempt remains pending.
  signal.throwIfAborted();
  throw new NoHandlerError(fullSubject);
}
