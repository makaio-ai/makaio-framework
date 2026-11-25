import type { BoundaryAccessCheck, BusBroadcastMessage, BusEventMessage, BusRequestMessage } from '@makaio/bus-core';
import { matchesSubscription, serializeTransportError, SUBSCRIPTION_DEFERRED } from '@makaio/bus-core';
import type { ClientRegistry } from './client-registry.js';
import { AccessDeniedError, callFromReceive, CoreDenialPlace } from '@makaio/bus-core/kernel-api';
import { JsonValueSchema, type CallContext, type TransportReceiveContext } from '@makaio/core';
import { canonicalStringify } from '@makaio/utils';
import type { TransportAuth, WebSocketLike } from './types.js';
import {
  resolveHmacIdentityAllowedMessageSubjects,
  resolveHmacIdentityAllowedSubscriptionSubjects,
} from './auth/identity-secret-registry.js';

export type BoundaryMessage = BusRequestMessage | BusEventMessage | BusBroadcastMessage;

interface BoundPeer {
  readonly call: CallContext;
  readonly connection: TransportReceiveContext;
}

type RevalidatePeer = () => BoundPeer | undefined;
interface SubscriptionAdmission {
  readonly subjects: Record<string, number[]>;
  readonly pending: Record<string, number[]>;
  readonly receiveContext: TransportReceiveContext | undefined;
}

/**
 * Check an advertised pattern against the peer's live subject policy.
 * @param pattern - Advertised subscription pattern.
 * @param allowed - Patterns permitted by the peer identity, or null for unrestricted.
 * @returns Whether the identity may advertise the pattern.
 */
export function allowsSubscriptionPattern(pattern: string, allowed: ReadonlySet<string> | null): boolean {
  if (allowed === null) return true;
  if (pattern.endsWith('*')) return allowed.has(pattern);
  return [...allowed].some((candidate) => matchesSubscription(pattern, candidate));
}

/**
 * Produce the JSON data transmitted to the peer.
 * @param payload - Inbound JSON or the payload of an outgoing application message.
 * @returns A JSON projection with standard WebSocket serialization semantics.
 */
function wirePayload(payload: unknown) {
  const encoded = JSON.stringify(payload);
  return encoded === undefined ? undefined : JsonValueSchema.parse(JSON.parse(encoded));
}

/**
 * Project once so filtering, authorization and sending use the same payload.
 * @param message - Message to project.
 * @returns Message carrying the wire representation of the payload.
 */
export function projectBoundaryMessage<T extends BoundaryMessage>(message: T): T {
  return { ...message, payload: wirePayload(message.payload) };
}

/** Connection-scoped access checks shared by server ingress and socket delivery. */
export class ServerBoundaryAccess {
  /**
   * @param name - Registered transport name.
   * @param auth - Supplies verified receive contexts.
   * @param check - Host boundary policy, when the server belongs to a host.
   */
  public constructor(
    private readonly name: string,
    private readonly auth: TransportAuth | undefined,
    private readonly check: BoundaryAccessCheck,
  ) {}

  /**
   * Capture the socket's call context, including any permitted principal attestation.
   * @param socket - Originating or receiving socket.
   * @param metadata - Principal metadata of an inbound message, if present.
   * @returns Bound call and trusted connection.
   */
  private bind(socket: WebSocketLike, metadata?: unknown): BoundPeer {
    const receive = this.auth?.getReceiveContext?.(socket);
    const connection = { ...receive, authenticated: receive?.authenticated ?? false, transportName: this.name };
    return { call: callFromReceive(connection, undefined, metadata, console.warn), connection };
  }

  /**
   * Rebind at the point a policy decision is used. The same socket must still
   * authenticate and present the connection facts and claims that were checked.
   * @param socket - Socket for which the policy decided.
   * @param checked - Peer snapshot passed to the policy.
   * @param eligible - Current routing or admission predicate, if applicable.
   * @param metadata - Incoming metadata used to bind the sender.
   * @returns The live bound peer while the decision still applies.
   */
  private revalidatePeer(
    socket: WebSocketLike,
    checked: BoundPeer,
    eligible?: () => boolean,
    metadata?: unknown,
  ): BoundPeer | undefined {
    if (socket.readyState !== 1) return undefined;
    if (this.auth?.isSocketAuthenticated?.(socket) === false) {
      this.auth.cleanupSocket(socket);
      socket.close(1008, 'Authentication expired');
      return undefined;
    }
    const live = this.bind(socket, metadata);
    const before = checked.connection;
    const after = live.connection;
    if (
      before.connectionId !== after.connectionId ||
      before.authenticated !== after.authenticated ||
      before.encrypted !== after.encrypted ||
      before.attests !== after.attests ||
      canonicalStringify(checked.call) !== canonicalStringify(live.call) ||
      eligible?.() === false
    ) {
      return undefined;
    }
    return live;
  }

  /**
   * Report a rejected reply using the socket's verified context.
   * @param socket - Peer that sent the discarded reply.
   * @param reason - Transport's reason for discarding the reply.
   * @returns Whether a host reporter handled the diagnostic.
   */
  public reportRejectedReply(socket: WebSocketLike, reason: string): boolean {
    if (this.check.reportRejectedReply === undefined) return false;
    this.check.reportRejectedReply(this.bind(socket).call, reason);
    return true;
  }

  /**
   * Listen for changes that can unblock replay admission.
   * @param retry - Schedule a full recheck of deferred patterns.
   * @returns The unsubscribe function when the host supports deferral.
   */
  public watchSubscriptionAvailability(retry: () => Promise<void>): (() => void) | undefined {
    return this.check.watchSubscriptionAvailability?.(retry);
  }

  /**
   * Authorize subscription patterns before touching per-peer routing state.
   * @param socket - Peer requesting the patterns.
   * @param subjects - Patterns admitted by the authentication policy.
   * @param acknowledged - Whether the peer expects acknowledgement of the whole update.
   * @param defer - Permitted deferral for this update.
   * @returns A final admission check or the reason for refusing the update.
   */
  public async admitSubscriptions(
    socket: WebSocketLike,
    subjects: Record<string, number[]>,
    acknowledged: boolean,
    defer: 'replay' | 'unavailable' | undefined,
  ): Promise<(() => SubscriptionAdmission | undefined) | Error | undefined> {
    const peer = this.bind(socket);
    const allows = (pattern: string): boolean => {
      const id = this.auth?.getAuthenticatedIdentityId?.(socket);
      return id === undefined || allowsSubscriptionPattern(pattern, resolveHmacIdentityAllowedSubscriptionSubjects(id));
    };
    const allowed: [string, number[]][] = [];
    const pending: [string, number[]][] = [];
    for (const [pattern, priorities] of Object.entries(subjects)) {
      if (socket.readyState !== 1) return undefined;
      const operation = priorities.length === 0 ? 'subscribe' : 'register-handler';
      const error = await this.check({ operation, pattern, defer }, peer.call, peer.connection);
      if (!this.revalidatePeer(socket, peer)) return undefined;
      if (!allows(pattern)) continue;
      if (error === SUBSCRIPTION_DEFERRED) {
        if (defer !== undefined) pending.push([pattern, priorities]);
        else return undefined;
      } else if (error === undefined) {
        allowed.push([pattern, priorities]);
      } else if (acknowledged) return error;
    }
    return () => {
      const live = this.revalidatePeer(socket, peer);
      if (live === undefined) return undefined;
      if ([...allowed, ...pending].some(([pattern]) => !allows(pattern))) return undefined;
      return {
        subjects: Object.fromEntries(allowed),
        pending: Object.fromEntries(pending),
        receiveContext: live.connection,
      };
    };
  }

  /**
   * Authorize an incoming application message or send its correlated denial.
   * @param message - Application message at the boundary.
   * @param socket - Originating socket.
   * @param send - Safe function for sending an error frame.
   * @returns A live peer check to run synchronously at dispatch, when granted.
   */
  public async authorizeSend(
    message: BoundaryMessage,
    socket: WebSocketLike,
    send: (socket: WebSocketLike, frame: string) => void,
  ): Promise<RevalidatePeer | undefined> {
    if (typeof message.namespace !== 'string' || typeof message.subject !== 'string') return undefined;
    const peer = this.bind(socket, message.metadata);
    const fullSubject = `${message.namespace}.${message.subject}`;
    const eligible = (): boolean => {
      const id = this.auth?.getAuthenticatedIdentityId?.(socket);
      return id === undefined || (resolveHmacIdentityAllowedMessageSubjects(id)?.has(fullSubject) ?? true);
    };
    const revalidate = (): BoundPeer | undefined => this.revalidatePeer(socket, peer, eligible, message.metadata);
    const error = await this.checkMessage('send', message, peer);
    if (!revalidate()) return undefined;
    if (error === undefined) return revalidate;
    sendRejectedMessage(message, socket, send, error);
    return undefined;
  }

  /**
   * Authorize one delivery using the peer's current identity.
   * @param message - Application message with projected payload.
   * @param socket - Intended recipient.
   * @param eligible - Live routing predicate for the intended recipient.
   * @returns A live peer check to run synchronously at delivery, when granted.
   */
  public async authorizeDelivery(
    message: BoundaryMessage,
    socket: WebSocketLike,
    eligible: () => boolean,
  ): Promise<RevalidatePeer | undefined> {
    const peer = this.bind(socket);
    const operation = message.type === 'event' ? 'deliver' : 'handle';
    const revalidate = (): BoundPeer | undefined => this.revalidatePeer(socket, peer, eligible);
    const error = await this.checkMessage(operation, message, peer);
    return revalidate() && error === undefined ? revalidate : undefined;
  }

  /**
   * Check an application message at the indicated side of the boundary.
   * @param operation - Sending or delivery.
   * @param message - Application message.
   * @param peer - Sending or receiving peer.
   * @returns A denial, if applicable.
   */
  private checkMessage(operation: 'send' | 'deliver' | 'handle', message: BoundaryMessage, peer: BoundPeer) {
    return this.check(
      {
        operation,
        messageType: message.type,
        namespace: message.namespace,
        subject: message.subject,
        payload: message.payload === undefined ? undefined : JsonValueSchema.parse(message.payload),
      },
      peer.call,
      peer.connection,
    );
  }
}

/**
 * Record a rejected reply in the host diagnostic, or warn for a standalone transport.
 * @param access - Host policy, when installed.
 * @param socket - Peer that sent the discarded reply.
 * @param reason - Transport's reason for discarding the reply.
 */
export function reportRejectedReply(
  access: ServerBoundaryAccess | undefined,
  socket: WebSocketLike,
  reason: string,
): void {
  if (!access?.reportRejectedReply(socket, reason)) console.warn('[ServerTransport] Rejected reply:', reason);
}

/**
 * Acknowledge a completed subscription update or return its refusal.
 * @param socket - Subscribing peer.
 * @param ackId - Acknowledgement key provided by the peer.
 * @param send - Safe frame sender.
 * @param error - Refusal or undefined after successful admission.
 */
export function sendSubscriptionAck(
  socket: WebSocketLike,
  ackId: string | undefined,
  send: (socket: WebSocketLike, frame: string) => void,
  error?: Error,
): void {
  if (typeof ackId === 'string' && socket.readyState === 1) {
    send(socket, JSON.stringify({ type: 'subscription-ack', ackId, error: error && serializeTransportError(error) }));
  }
}

/**
 * Describe a subscription update that could not be applied.
 * @param reason - Reason for refusing the update.
 * @returns A typed rejection for the acknowledgement.
 */
export function subscriptionRejection(
  reason: 'peer-changed' | 'subscription-dispatch-failed' | 'subscription-not-admitted',
): Error {
  return new AccessDeniedError({ at: CoreDenialPlace.subscribe, reason });
}

/**
 * Report a correlated denial when the peer expects a reply.
 * @param message - Application message at the boundary.
 * @param socket - Originating socket.
 * @param send - Safe function for sending an error frame.
 * @param error - Denial to report.
 */
export function sendRejectedMessage(
  message: BoundaryMessage,
  socket: WebSocketLike,
  send: (socket: WebSocketLike, frame: string) => void,
  error: Error | typeof SUBSCRIPTION_DEFERRED,
): void {
  if (message.type !== 'event') {
    send(
      socket,
      JSON.stringify({
        type: message.type === 'request' ? 'response' : 'broadcast-response',
        correlationId: message.correlationId,
        error: serializeTransportError(
          error === SUBSCRIPTION_DEFERRED ? new Error('Invalid boundary policy result') : error,
        ),
      }),
    );
  }
}

/**
 * Apply the delivery check to each subscriber independently.
 * @param deps - Server access policy and subscription state.
 * @param clients - Sockets whose subscriptions and filters match.
 * @param message - Message to deliver.
 * @returns A synchronous snapshot of the authorized sockets that remain eligible.
 */
export async function authorizedRecipients(
  deps: { access?: ServerBoundaryAccess; registry: ClientRegistry },
  clients: WebSocketLike[],
  message: BusEventMessage | BusBroadcastMessage,
): Promise<() => WebSocketLike[]> {
  const { access, registry } = deps;
  if (!access) return () => clients;
  const subject = `${message.namespace}.${message.subject}`;
  const subscription = message.type === 'broadcast' ? 'handler' : 'any';
  const granted = await Promise.all(
    clients.map((client) => {
      const eligible = (): boolean => registry.matchesDelivery(client, subject, message.payload, subscription);
      return eligible() ? access.authorizeDelivery(message, client, eligible) : undefined;
    }),
  );
  return () => clients.filter((_client, index) => granted[index]?.() !== undefined);
}

/**
 * Restamp forwarded metadata with the principal accepted by this host.
 * @param message - Peer event or broadcast.
 * @param receiveContext - Authentication-derived sender context.
 * @returns Message carrying only the accepted principal.
 */
export function restampForClientFanout<T extends BusEventMessage | BusBroadcastMessage>(
  message: T,
  receiveContext: TransportReceiveContext | undefined,
): T {
  const { principal } = callFromReceive(receiveContext, undefined, message.metadata, console.warn);
  return { ...message, metadata: { principal: { kind: principal.kind, id: principal.id } } };
}

/**
 * Forward an event to eligible peers before the bus relays it to other transports.
 * @param message - Inbound event.
 * @param socket - Originating peer.
 * @param deps - Access policy, subscriptions and frame sender.
 * @param receiveContext - Authentication-derived sender context.
 * @param currentSender - Revalidate the sender after recipient authorization.
 * @returns Whether the event can also dispatch locally.
 */
export async function forwardAuthorizedEvent(
  message: BusEventMessage,
  socket: WebSocketLike,
  deps: {
    access?: ServerBoundaryAccess;
    registry: ClientRegistry;
    sendSafely: (socket: WebSocketLike, frame: string) => void;
  },
  receiveContext: TransportReceiveContext | undefined,
  currentSender: () => unknown,
): Promise<boolean> {
  const outgoing = restampForClientFanout(message, receiveContext);
  if (deps.access === undefined) {
    deps.registry.forwardEventToClients(socket, outgoing, deps.sendSafely);
    return true;
  }
  const candidates = deps.registry.getInterestedClients(
    `${message.namespace}.${message.subject}`,
    message.payload,
    socket,
  );
  const targets = await authorizedRecipients(deps, candidates, message);
  if (!currentSender()) return false;
  const wire = JSON.stringify(outgoing);
  for (const client of targets()) deps.sendSafely(client, wire);
  return true;
}
