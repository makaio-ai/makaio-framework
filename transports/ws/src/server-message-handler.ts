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
  BusMessage,
  BusReceiveHandler,
  BusSubscribeMessage,
  BusUnsubscribeMessage,
  CorrelationTracker,
} from '@makaio/bus-core';
import { deserializeTransportError, getSubjectFromBusMessage } from '@makaio/bus-core';
import { isRecord } from '@makaio/utils';
import {
  allowsSubscriptionPattern,
  authorizedRecipients,
  forwardAuthorizedEvent,
  restampForClientFanout,
  reportRejectedReply,
  sendSubscriptionAck,
  subscriptionRejection,
  type ServerBoundaryAccess,
} from './server-boundary-access.js';
import { createSubscriptionQueue, type DeferredSubscriptionReplay } from './deferred-subscription-replay.js';
import { anchorInboundRequestBudget, prepareInboundRequest } from './inbound-request-budget.js';
import type { TransportAuth, WebSocketLike } from './types.js';
import type { BroadcastAggregator } from './broadcast-aggregator.js';
import type { ClientRegistry, ClientSubscriptionUpdate } from './client-registry.js';
import type { TransportReceiveContext } from '@makaio/core';
import {
  resolveHmacIdentityAllowedMessageSubjects,
  resolveHmacIdentityAllowedSubscriptionSubjects,
} from './auth/identity-secret-registry.js';

/**
 * Bus message types that carry a `namespace` and `subject`.
 *
 * Used by the subject-restriction gate to narrow the `BusMessage` union
 * without guarded `as` casts.
 */
type SubjectBearingBusMessage = Extract<BusMessage, { type: 'request' | 'event' | 'broadcast' }>;

/** Subject restriction resolved for an authenticated peer. */
interface SubjectRestriction {
  /** Authenticated peer identity. */
  readonly peerId: string;
  /** Subjects the peer may send in request, event, or broadcast messages. */
  readonly allowedMessageSubjects: ReadonlySet<string> | null;
  /** Subjects the peer may advertise in subscribe or unsubscribe messages. */
  readonly allowedSubscriptionSubjects: ReadonlySet<string> | null;
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
 * Identify subscription state updates that must run in arrival order.
 * @param message - Inbound bus message.
 * @returns Whether this is a subscribe or unsubscribe message.
 */
function isSubscriptionMessage(message: BusMessage): message is BusSubscribeMessage | BusUnsubscribeMessage {
  return message.type === 'subscribe' || message.type === 'unsubscribe';
}

/**
 * Dependencies injected into each per-socket message handler.
 */
export interface MessageHandlerDeps {
  /** External policy for this server. */
  access?: ServerBoundaryAccess;
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
  sendSafely: (client: WebSocketLike, data: string) => boolean;
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
 * Filter a subscription subjects map against its allowed-subscription-subjects list.
 *
 * For restricted identities, each subject key is checked:
 * - When an allow list exists, wildcard patterns are allowed only when they
 *   appear **verbatim** in that list (e.g. `adapter.*` is allowed only if
 *   `allowedSubscriptionSubjects` contains `adapter.*` literally). This
 *   prevents a wildcard from matching subjects outside the allow list.
 * - Exact subjects are allowed when they appear in the allowed list or match an
 *   allowed wildcard pattern.
 *
 * Returns a new subjects map with disallowed entries removed, or `null` when
 * the filtered map is empty (indicating the entire message should be dropped).
 * @param subjects - Inbound subscription subjects map.
 * @param allowedSubscriptionSubjects - The peer's allowed subscription subjects list.
 * @param debug - Whether to log filtering decisions.
 * @param peerId - Peer identity for log messages.
 * @returns Filtered subjects map, or `null` when all subjects were removed.
 */
function filterSubscriptionSubjects(
  subjects: Record<string, number[]>,
  allowedSubscriptionSubjects: ReadonlySet<string> | null,
  debug: boolean,
  peerId: string,
): Record<string, number[]> | null {
  const filtered: Record<string, number[]> = {};

  for (const [subject, priorities] of Object.entries(subjects)) {
    if (allowsSubscriptionPattern(subject, allowedSubscriptionSubjects)) {
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
    Array.from(handlers, async (handler) => handler(message, options.receiveContext)),
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
 * Publish one aggregate snapshot without awaiting between disjoint updates.
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
  // Begin publication for every pattern before another socket can change the aggregate.
  const applied = await Promise.all(updates.map((update) => invokeHandlers(update, handlers, options)));
  return applied.every(Boolean);
}

/**
 * Settle replies against the deliveries owned by this socket.
 * @param message - Inbound bus message
 * @param deps - Handler dependencies
 * @param socket - The originating client socket
 * @returns `true` when the message was handled and no further processing is needed
 */
function handleCorrelationMessage(message: BusMessage, deps: MessageHandlerDeps, socket: WebSocketLike): boolean {
  const { correlations, broadcastAggregator, access } = deps;

  if (message.type === 'heartbeat') return true;

  if (message.type === 'response') {
    if (typeof message.correlationId !== 'string') {
      reportRejectedReply(access, socket, 'malformed-response');
    } else if (!correlations.has(message.correlationId)) {
      reportRejectedReply(access, socket, 'response-without-delivery');
    } else if (message.error) {
      correlations.reject(message.correlationId, deserializeTransportError(message.error));
    } else {
      correlations.resolve(message.correlationId, message.result);
    }
    return true;
  }

  if (message.type === 'broadcast-response') {
    if (typeof message.correlationId !== 'string') {
      reportRejectedReply(access, socket, 'malformed-broadcast-response');
    } else if (!broadcastAggregator.handleResponse(socket, message)) {
      reportRejectedReply(access, socket, 'broadcast-response-without-delivery');
    }
    return true;
  }

  return false;
}

/**
 * Resolve the current subject restriction for an inbound socket.
 * @param peerId - Identity verified by the socket's authentication strategy.
 * @returns The peer restriction, or `null` when neither subject direction is restricted.
 */
function resolveSubjectRestriction(peerId: string | undefined): SubjectRestriction | null {
  if (peerId === undefined) return null;

  const allowedMessageSubjects = resolveHmacIdentityAllowedMessageSubjects(peerId);
  const allowedSubscriptionSubjects = resolveHmacIdentityAllowedSubscriptionSubjects(peerId);
  if (allowedMessageSubjects === null && allowedSubscriptionSubjects === null) {
    return null;
  }
  return {
    peerId,
    allowedMessageSubjects,
    allowedSubscriptionSubjects,
  };
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
  if (restriction.allowedMessageSubjects === null || restriction.allowedMessageSubjects.has(fullSubject)) return false;

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
 * Validate the update and apply the identity filter.
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

  const filtered = filterSubscriptionSubjects(
    message.subjects,
    restriction.allowedSubscriptionSubjects,
    debug,
    restriction.peerId,
  );
  if (filtered === null && debug) {
    console.debug(
      `[ServerTransport] Dropping ${message.type} message: all subjects filtered for peer '${restriction.peerId}'`,
    );
  }
  return filtered;
}

/**
 * Apply a subscription update through admission and dispatch.
 * @param message - Inbound bus message.
 * @param socket - Socket that sent the message.
 * @param deps - Handler dependencies.
 * @param receiveContext - Authentication-derived receive context.
 * @param restriction - Current peer subject restriction.
 * @param replay - Deferred advertisements on this socket.
 * @returns The refusal if the update could not be applied.
 */
async function routeSubscriptionMessage(
  message: BusSubscribeMessage | BusUnsubscribeMessage,
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  receiveContext: TransportReceiveContext | undefined,
  restriction: SubjectRestriction | null,
  replay?: DeferredSubscriptionReplay,
): Promise<Error | undefined> {
  const acknowledged = typeof message.ackId === 'string';
  const subjects = resolveSubscriptionSubjects(message, restriction, deps.debug);
  if (subjects === null) {
    // A replay consumes its entry when the current identity denies all its patterns.
    if (!acknowledged && isSubscriptionSubjects(message.subjects)) replay?.forget(message.subjects);
    return subscriptionRejection('subscription-not-admitted');
  }

  const defer = replay && (acknowledged ? 'unavailable' : 'replay');
  const admit =
    message.type === 'subscribe' && deps.access
      ? await deps.access.admitSubscriptions(socket, subjects, acknowledged, defer)
      : () => (socket.readyState === 1 ? { subjects, pending: {}, receiveContext } : undefined);
  if (typeof admit !== 'function') return admit ?? subscriptionRejection('peer-changed');
  const admitted = admit();
  if (admitted === undefined) return subscriptionRejection('peer-changed');

  const { subjects: allowed, pending } = admitted;
  const superseded = message.type === 'unsubscribe' || !acknowledged ? message.subjects : allowed;
  const rollbackReplay = replay?.stage(message, superseded, pending);
  let rollback: (() => ClientSubscriptionUpdate[]) | undefined;
  let committed = false;
  const dispatch = {
    debug: deps.debug,
    receiveContext: admitted.receiveContext,
    logContext: `dispatching ${message.type}`,
  };
  try {
    const staged = deps.registry.stageSubscriptionUpdate(socket, { ...message, subjects: allowed }, pending);
    rollback = staged.rollback;
    const handlersApplied = await invokeSubscriptionUpdates(staged.updates, deps.handlers, dispatch);
    if (admit() === undefined) return subscriptionRejection('peer-changed');
    if (!handlersApplied) return subscriptionRejection('subscription-dispatch-failed');
    committed = true;
  } finally {
    if (!committed) {
      rollbackReplay?.();
      if (rollback !== undefined) await invokeSubscriptionUpdates(rollback(), deps.handlers, dispatch);
    }
  }
}

/**
 * Forward a client broadcast and deliver it to server-local handlers.
 * @param message - Inbound bus message.
 * @param socket - Socket that sent the message.
 * @param deps - Handler dependencies.
 * @param receiveContext - Authentication-derived receive context.
 * @param currentSender - Revalidate the sender at dispatch when access is enforced.
 */
async function routeBroadcastMessage(
  message: BusBroadcastMessage,
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  receiveContext: TransportReceiveContext | undefined,
  currentSender: () => unknown,
): Promise<void> {
  if (typeof message.correlationId !== 'string' || typeof message.subject !== 'string') {
    if (deps.debug) console.warn('[ServerTransport] Malformed broadcast message: missing correlationId or subject');
    return;
  }

  const subject = getSubjectFromBusMessage(message) ?? undefined;
  const candidates = deps.registry.getInterestedClients(subject, message.payload, socket);
  const targetClients = await authorizedRecipients(deps, candidates, message);
  if (deps.access && !currentSender()) return;
  const timeout = deps.normalizeBroadcastTimeout(message.timeout);
  const outgoing = restampForClientFanout(message, receiveContext);
  const local = deps.broadcastAggregator.startClientBroadcast(
    socket,
    outgoing,
    targetClients(),
    deps.sendSafely,
    timeout,
  );
  await invokeHandlers({ ...message, correlationId: local }, deps.handlers, { debug: deps.debug, receiveContext });
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
 * @param replay - Deferred advertisements on this socket.
 * @internal Exported for unit testing only.
 */
export async function routeMessage(
  message: BusMessage,
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  replay?: DeferredSubscriptionReplay,
): Promise<void> {
  if (handleCorrelationMessage(message, deps, socket)) return;

  const requestBudget = anchorInboundRequestBudget(message);
  const restriction = resolveSubjectRestriction(deps.auth?.getAuthenticatedIdentityId?.(socket));

  if (rejectDisallowedSubject(message, socket, deps, restriction)) return;
  const currentSender =
    isSubjectBearingMessage(message) && deps.access
      ? await deps.access.authorizeSend(message, socket, deps.sendSafely)
      : () => ({ connection: deps.auth?.getReceiveContext?.(socket) });
  if (currentSender === undefined) return;
  const sender = currentSender();
  if (sender === undefined) return;
  const receiveContext = sender.connection;
  if (isSubscriptionMessage(message)) {
    const error = await routeSubscriptionMessage(message, socket, deps, receiveContext, restriction, replay).catch(
      (error: unknown) => {
        if (deps.debug) console.error('[ServerTransport] Failed to apply subscription:', error);
        return subscriptionRejection('subscription-dispatch-failed');
      },
    );
    sendSubscriptionAck(socket, message.ackId, deps.sendSafely, error);
    return;
  }
  if (message.type === 'broadcast') {
    await routeBroadcastMessage(message, socket, deps, receiveContext, currentSender);
    return;
  }

  if (message.type === 'event') {
    if (await forwardAuthorizedEvent(message, socket, deps, receiveContext, currentSender)) {
      await invokeHandlers(message, deps.handlers, { debug: deps.debug, receiveContext });
    }
    return;
  }

  if (message.type === 'request') {
    const request = prepareInboundRequest(message, requestBudget, socket, deps.sendSafely);
    if (request === undefined) return;
    deps.registry.trackRequestOrigin(socket, request);
    message = request;
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
 * @param lifetime - Aborted when the connection closes.
 * @returns Async message handler function
 */
export function createInboundMessageHandler(
  socket: WebSocketLike,
  deps: MessageHandlerDeps,
  lifetime?: AbortSignal,
): (data: string | Buffer) => Promise<void> {
  const { auth, registry, debug } = deps;
  const queueSubscription = createSubscriptionQueue(
    socket,
    deps,
    registry.deferredSubscriptionsFor(socket),
    (message, replay) => routeMessage(message, socket, deps, replay),
    lifetime,
  );

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

      if (isSubscriptionMessage(message)) {
        await queueSubscription(message, Buffer.byteLength(data));
      } else {
        await routeMessage(message, socket, deps);
      }
    } catch (error) {
      if (debug) {
        // Processing failures are logged separately from malformed JSON so
        // auth/routing defects are not hidden as wire-format problems.
        console.error('[ServerTransport] Failed to process message:', error);
      }
    }
  };
}
