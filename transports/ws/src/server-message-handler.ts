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
  BusEventMessage,
  BusMessage,
  BusReceiveHandler,
  BusRequestMessage,
  BusResponseMessage,
  BusSubscribeMessage,
  BusUnsubscribeMessage,
  CorrelationTracker,
} from '@makaio/bus-core';
import { deserializeTransportError } from '@makaio/bus-core';
import { isRecord } from '@makaio/utils';
import type { TransportAuth, WebSocketLike } from './types.js';
import type { BroadcastAggregator } from './broadcast-aggregator.js';
import type { ClientRegistry, ClientSubscriptionUpdate } from './client-registry.js';
import type { TransportReceiveContext } from '@makaio/core';
import { resolveHmacIdentityAllowedSubjects } from './auth/identity-secret-registry.js';

/**
 * Bus message types that carry a `namespace` and `subject`.
 *
 * Used by the subject-restriction gate to narrow the `BusMessage` union
 * without guarded `as` casts.
 */
type SubjectBearingBusMessage = BusRequestMessage | BusEventMessage | BusBroadcastMessage;

/** Subject restriction resolved for an authenticated peer. */
interface SubjectRestriction {
  /** Authenticated peer identity. */
  readonly peerId: string;
  /** Subjects the peer may send or advertise. */
  readonly allowedSubjects: ReadonlySet<string>;
}

/**
 * Type guard for bus messages that carry `namespace` and `subject`.
 *
 * Narrows the discriminated `BusMessage` union to the three member types
 * that always have both fields, replacing the previous guarded `as` casts
 * in the subject-restriction block.
 * @param message - Inbound bus message.
 * @returns `true` when the message has `namespace` and `subject` fields.
 */
function isSubjectBearingMessage(message: BusMessage): message is SubjectBearingBusMessage {
  return message.type === 'request' || message.type === 'event' || message.type === 'broadcast';
}

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
 * Validate the priority arrays carried by subscription control messages.
 * @param value - Untrusted subjects payload
 * @returns True when every subject maps to finite numeric priorities
 */
function isSubscriptionSubjects(value: unknown): value is Record<string, number[]> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (priorities) =>
        Array.isArray(priorities) &&
        priorities.every((priority) => typeof priority === 'number' && Number.isFinite(priority)),
    )
  );
}

/**
 * Check whether a subscription subject key is a wildcard pattern.
 *
 * Wildcard patterns end with `*` (e.g. `adapter.*`, `worker-node:*`, or the
 * global `*`).
 * @param subject - Subscription subject key to check.
 * @returns `true` when the key is a wildcard pattern.
 */
function isWildcardPattern(subject: string): boolean {
  return subject.endsWith('*');
}

/**
 * Filter a subscription subjects map against an allowed-subjects list.
 *
 * For restricted identities, each subject key is checked:
 * - Wildcard patterns are allowed only when they appear **verbatim** in the
 *   allowed list (e.g. `adapter.*` is allowed only if `allowedSubjects`
 *   contains `adapter.*` literally). This prevents a wildcard from matching
 *   subjects outside the allow list.
 * - Exact subjects are allowed when they appear in the allowed list.
 *
 * Returns a new subjects map with disallowed entries removed, or `null` when
 * the filtered map is empty (indicating the entire message should be dropped).
 * @param subjects - Inbound subscription subjects map.
 * @param allowedSubjects - The peer's allowed subjects list.
 * @param debug - Whether to log filtering decisions.
 * @param peerId - Peer identity for log messages.
 * @returns Filtered subjects map, or `null` when all subjects were removed.
 */
function filterSubscriptionSubjects(
  subjects: Record<string, number[]>,
  allowedSubjects: ReadonlySet<string>,
  debug: boolean,
  peerId: string,
): Record<string, number[]> | null {
  const filtered: Record<string, number[]> = {};

  for (const [subject, priorities] of Object.entries(subjects)) {
    if (isWildcardPattern(subject)) {
      // Wildcards are only allowed when they appear verbatim in the allow set.
      if (allowedSubjects.has(subject)) {
        filtered[subject] = priorities;
      } else if (debug) {
        console.debug(
          `[ServerTransport] Dropping wildcard subscription ` +
            `'${subject}': not in allowedSubjects for peer '${peerId}'`,
        );
      }
    } else if (allowedSubjects.has(subject)) {
      filtered[subject] = priorities;
    } else if (debug) {
      console.debug(
        `[ServerTransport] Dropping subscription subject ` + `'${subject}': not allowed for peer '${peerId}'`,
      );
    }
  }

  return Object.keys(filtered).length > 0 ? filtered : null;
}

/**
 * Invoke all registered bus handlers for a message, swallowing per-handler errors.
 *
 * Handler errors are swallowed to keep propagation best-effort.
 * @param message - Bus message to dispatch
 * @param handlers - Set of registered bus handlers
 * @param options - Dispatch options
 * @returns True when every registered handler completed successfully
 */
async function invokeHandlers(
  message: BusMessage,
  handlers: Set<BusReceiveHandler>,
  options: {
    debug: boolean;
    receiveContext?: TransportReceiveContext;
    logContext?: string;
  },
): Promise<boolean> {
  const results = await Promise.allSettled(
    Array.from(handlers).map((handler) => handler(message, options.receiveContext)),
  );

  for (const result of results) {
    if (result.status === 'rejected' && options.debug) {
      const suffix = options.logContext ? ` ${options.logContext}` : '';
      console.error(`[ServerTransport] Handler error${suffix}:`, result.reason);
    }
  }

  return results.every((result) => result.status === 'fulfilled');
}

/**
 * Dispatch authoritative transport-level subscription updates in order.
 * @param updates - Aggregate control messages produced by the client registry
 * @param handlers - Registered bus handlers
 * @param options - Dispatch and logging context
 * @returns True when every update reached every handler successfully
 */
export async function invokeSubscriptionUpdates(
  updates: ClientSubscriptionUpdate[],
  handlers: Set<BusReceiveHandler>,
  options: {
    debug: boolean;
    receiveContext?: TransportReceiveContext;
    logContext?: string;
  },
): Promise<boolean> {
  let allApplied = true;
  for (const update of updates) {
    if (!(await invokeHandlers(update, handlers, options))) allApplied = false;
  }
  return allApplied;
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
 * Resolve the current subject restriction for an inbound socket.
 * @param receiveContext - Authentication-derived receive context.
 * @returns The peer restriction, or `null` for an unrestricted peer.
 */
function resolveSubjectRestriction(receiveContext: TransportReceiveContext | undefined): SubjectRestriction | null {
  const peerId = receiveContext?.peer?.id;
  if (peerId === undefined) return null;

  const allowedSubjects = resolveHmacIdentityAllowedSubjects(peerId);
  return allowedSubjects === null ? null : { peerId, allowedSubjects };
}

/**
 * Reject a subject-bearing message that its authenticated peer may not send.
 * @param message - Inbound bus message.
 * @param socket - Socket that sent the message.
 * @param deps - Handler dependencies.
 * @param restriction - Current peer subject restriction.
 * @returns `true` when the message was rejected.
 */
function rejectDisallowedSubject(
  message: BusMessage,
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  restriction: SubjectRestriction | null,
): boolean {
  if (restriction === null || !isSubjectBearingMessage(message)) return false;

  const fullSubject = `${message.namespace}.${message.subject}`;
  if (restriction.allowedSubjects.has(fullSubject)) return false;

  if (message.type === 'request') {
    deps.sendSafely(
      socket,
      JSON.stringify({
        type: 'response',
        correlationId: message.correlationId,
        error: { message: `Subject '${fullSubject}' is not allowed for peer '${restriction.peerId}'` },
      }),
    );
  }
  if (deps.debug) {
    console.warn(
      `[ServerTransport] Dropping ${message.type} to '${fullSubject}': not allowed for peer '${restriction.peerId}'`,
    );
  }
  return true;
}

/**
 * Validate and filter a subscription control message for its authenticated peer.
 * @param message - Inbound subscription control message.
 * @param restriction - Current peer subject restriction.
 * @param debug - Whether to log dropped messages.
 * @returns Effective subjects, or `null` when the message must be dropped.
 */
function resolveSubscriptionSubjects(
  message: BusSubscribeMessage | BusUnsubscribeMessage,
  restriction: SubjectRestriction | null,
  debug: boolean,
): Record<string, number[]> | null {
  if (!isSubscriptionSubjects(message.subjects)) {
    if (debug) console.warn(`[ServerTransport] Malformed ${message.type} message: missing subjects record`);
    return null;
  }
  if (restriction === null) return message.subjects;

  const filtered = filterSubscriptionSubjects(message.subjects, restriction.allowedSubjects, debug, restriction.peerId);
  if (filtered === null && debug) {
    console.debug(
      `[ServerTransport] Dropping ${message.type} message: all subjects filtered for peer '${restriction.peerId}'`,
    );
  }
  return filtered;
}

/**
 * Route subscription updates through the registry and acknowledge successful dispatch.
 * @param message - Inbound bus message.
 * @param socket - Socket that sent the message.
 * @param deps - Handler dependencies.
 * @param receiveContext - Authentication-derived receive context.
 * @param restriction - Current peer subject restriction.
 * @returns `true` when the message was a subscription control message.
 */
async function routeSubscriptionMessage(
  message: BusMessage,
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  receiveContext: TransportReceiveContext | undefined,
  restriction: SubjectRestriction | null,
): Promise<boolean> {
  if (message.type !== 'subscribe' && message.type !== 'unsubscribe') return false;

  const subscriptionMessage = message as BusSubscribeMessage | BusUnsubscribeMessage;
  const subjects = resolveSubscriptionSubjects(subscriptionMessage, restriction, deps.debug);
  if (subjects === null) return true;

  const updates =
    subscriptionMessage.type === 'subscribe'
      ? deps.registry.handleSubscribeMessage(socket, { ...subscriptionMessage, subjects })
      : deps.registry.handleUnsubscribeMessage(socket, subjects);
  const handlersApplied = await invokeSubscriptionUpdates(updates, deps.handlers, {
    debug: deps.debug,
    receiveContext,
    logContext: `dispatching ${subscriptionMessage.type}`,
  });
  if (handlersApplied && typeof subscriptionMessage.ackId === 'string') {
    deps.sendSafely(socket, JSON.stringify({ type: 'subscription-ack', ackId: subscriptionMessage.ackId }));
  }
  return true;
}

/**
 * Forward a client broadcast and deliver it to server-local handlers.
 * @param message - Inbound bus message.
 * @param socket - Socket that sent the message.
 * @param deps - Handler dependencies.
 * @param receiveContext - Authentication-derived receive context.
 * @returns `true` when the message was a broadcast.
 */
async function routeBroadcastMessage(
  message: BusMessage,
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  receiveContext: TransportReceiveContext | undefined,
): Promise<boolean> {
  if (message.type !== 'broadcast') return false;

  const broadcastMessage = message as BusBroadcastMessage;
  if (typeof broadcastMessage.correlationId !== 'string' || typeof broadcastMessage.subject !== 'string') {
    if (deps.debug) console.warn('[ServerTransport] Malformed broadcast message: missing correlationId or subject');
    return true;
  }

  const targetClients = deps.registry.getInterestedClients(broadcastMessage.subject, broadcastMessage.payload, socket);
  const timeout = deps.normalizeBroadcastTimeout(broadcastMessage.timeout);
  deps.broadcastAggregator.startClientBroadcast(socket, broadcastMessage, targetClients, deps.sendSafely, timeout);
  await invokeHandlers(message, deps.handlers, { debug: deps.debug, receiveContext });
  return true;
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
  if (handleCorrelationMessage(message, deps, socket)) return;

  const receiveContext = deps.auth?.getReceiveContext?.(socket);
  const restriction = resolveSubjectRestriction(receiveContext);

  if (rejectDisallowedSubject(message, socket, deps, restriction)) return;
  if (message.type === 'subscribe' || message.type === 'unsubscribe') {
    await routeSubscriptionMessage(message, socket, deps, receiveContext, restriction);
    return;
  }
  if (message.type === 'broadcast') {
    await routeBroadcastMessage(message, socket, deps, receiveContext);
    return;
  }

  // Forward events from one client to other interested clients.
  // The transport registry relays events to OTHER transports but excludes
  // the source (ServerTransport) to prevent loops. Cross-client forwarding
  // within the same ServerTransport must happen here.
  if (message.type === 'event') {
    deps.registry.forwardEventToClients(socket, message, deps.sendSafely);
  }

  if (message.type === 'request') {
    deps.registry.trackRequestOrigin(socket, message);
  }

  // Call all registered handlers in parallel.
  await invokeHandlers(message, deps.handlers, { debug: deps.debug, receiveContext });
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

      if (auth?.isSocketAuthenticated?.(socket) === false) {
        if (debug) {
          console.warn('[ServerTransport] Closing socket with expired authentication');
        }
        auth.cleanupSocket(socket);
        socket.close(1008, 'Authentication expired');
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
