/**
 * Per-client state management for the server-mode WebSocket transport.
 *
 * Tracks connected clients, their subscription subjects, payload filters,
 * and provides routing helpers used by the server transport to deliver
 * messages to interested clients.
 */

import type {
  BusMessage,
  BusRequestMessage,
  BusSubscribeMessage,
  BusUnsubscribeMessage,
  SubscriptionDeliveryClass,
} from '@makaio/bus-core';
import type { PayloadFilter, TransportRequestOrigin } from '@makaio/core';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  getSubjectFromBusMessage,
  matchesFilter,
  matchesSubscription,
  resolveInboundRequestBudget,
  shouldReceiveMessage,
} from '@makaio/bus-core';
import { DeferredSubscriptionReplay } from './deferred-subscription-replay.js';
import type { WebSocketLike } from './types.js';

/**
 * Callback that resolves subscription subjects allowed for a client socket.
 *
 * Returns the live restriction list when the client's authenticated identity
 * declares `allowedSubscriptionSubjects`, or `null` when the client is
 * unrestricted (either because the identity has no restriction, or the
 * identity is unknown).
 *
 * Implementations should resolve from the live identity-secret-registry so
 * revocations and rotations are reflected immediately — matching the per-message
 * revalidation freshness for subscription handling on the inbound path.
 * @param client - The WebSocket client to resolve restrictions for.
 * @returns Allowed subscription subjects list, or `null` when unrestricted.
 */
export type SubscriptionSubjectRestrictionResolver = (client: WebSocketLike) => ReadonlySet<string> | null;

/**
 * Callback that resolves server-owned payload filters required for a client.
 *
 * The resolver is evaluated for every outbound delivery so its filters remain
 * effective when the client has no active subscription advertisement.
 * @param client - The WebSocket client.
 * @returns Required exact-subject filters, or `null` when no policy applies.
 */
export type RequiredSubscriptionFilterResolver = (
  client: WebSocketLike,
) => Readonly<Record<string, PayloadFilter>> | null;

/**
 * Callback that checks whether a client socket is still authenticated.
 *
 * When provided, outbound routing skips clients whose authentication
 * has expired (e.g. after identity secret rotation or revocation).
 * This closes the gap where rotated/revoked sockets continue receiving
 * subscribed events until their next inbound frame.
 * @param client - The WebSocket client to check.
 * @returns `true` when the client is still authenticated.
 */
export type SocketAuthChecker = (client: WebSocketLike) => boolean;

/**
 * Options for `ClientRegistry`.
 */
export interface ClientRegistryOptions {
  /** Enable debug logging. */
  debug?: boolean;
  /** Delivery mode for connections without an admitted subscription. */
  unsubscribedDelivery?: 'deliver' | 'drop';
  /**
   * Optional callback that resolves subscription subject restrictions for a
   * client socket.
   *
   * When provided, outbound peer delivery skips clients whose subscription
   * restriction list does not match the message subject. This provides
   * defense-in-depth for the inbound subscription authorization.
   */
  subscriptionSubjectRestrictionResolver?: SubscriptionSubjectRestrictionResolver;
  /**
   * Optional callback that resolves server-owned payload filters required for
   * a client. These filters are enforced on every outbound delivery,
   * independently of its advertised subscriptions.
   */
  requiredSubscriptionFilterResolver?: RequiredSubscriptionFilterResolver;
  /**
   * Optional callback that checks whether a client socket is still
   * authenticated. When provided, outbound routing skips and closes
   * clients whose authentication has expired (e.g. after identity
   * secret rotation). The inbound `isSocketAuthenticated` check
   * remains as defense-in-depth.
   */
  socketAuthChecker?: SocketAuthChecker;
}

interface ClientSubscriptionState {
  priorities: number[];
  deliveryClass: SubscriptionDeliveryClass;
}

const FINAL_RESPONSE_HANDOFF_MS = 1_000;

interface RequestOrigin {
  readonly handle?: TransportRequestOrigin;
  readonly wireCorrelationId?: string;
  retirement?: { readonly deadline: number; readonly finish: () => void };
  socket: WebSocketLike;
  expiration: ReturnType<typeof setTimeout> | undefined;
}

/** Transport-level subscription updates produced after per-client state changes. */
export type ClientSubscriptionUpdate = BusSubscribeMessage | BusUnsubscribeMessage;

interface StagedSubscriptionUpdate {
  /** Aggregate routing changes for the staged update. */
  updates: ClientSubscriptionUpdate[];
  /** Restore the previous state and return its aggregate routing changes. */
  rollback: () => ClientSubscriptionUpdate[];
}

type DeliverySubscription = 'any' | 'handler';

/**
 * Manages the set of connected WebSocket clients and their per-client state.
 *
 * Responsibilities:
 * - Tracks which clients are fully authenticated vs. still authenticating.
 * - Tracks per-client subscription subjects and payload filters.
 * - Provides helpers for routing (interested clients, request priority).
 * - Forwards events between clients within the same server transport instance.
 *
 * This class is intentionally free of I/O — all message sends are performed
 * by the caller via `sendSafely`.
 */
export class ClientRegistry {
  private readonly clients = new Set<WebSocketLike>();
  private readonly clientsByConnectionId = new Map<string, WebSocketLike>();
  private readonly authenticatingClients = new Set<WebSocketLike>();
  private readonly deferredSubscriptions = new Map<WebSocketLike, DeferredSubscriptionReplay>();
  private readonly clientSubscriptions = new Map<WebSocketLike, Set<string>>();
  private readonly clientSubscriptionState = new Map<WebSocketLike, Map<string, ClientSubscriptionState>>();
  private readonly clientFilters = new Map<WebSocketLike, Map<string, PayloadFilter>>();
  private readonly requestOrigins = new Map<string, RequestOrigin>();
  private readonly debug: boolean;
  private readonly unsubscribedDelivery: 'deliver' | 'drop';
  private readonly subscriptionSubjectRestrictionResolver: SubscriptionSubjectRestrictionResolver | undefined;
  private readonly requiredSubscriptionFilterResolver: RequiredSubscriptionFilterResolver | undefined;
  private readonly socketAuthChecker: SocketAuthChecker | undefined;

  /**
   * @param options - Registry configuration
   */
  public constructor(options: ClientRegistryOptions = {}) {
    this.debug = options.debug ?? false;
    this.unsubscribedDelivery = options.unsubscribedDelivery ?? 'drop';
    this.subscriptionSubjectRestrictionResolver = options.subscriptionSubjectRestrictionResolver;
    this.requiredSubscriptionFilterResolver = options.requiredSubscriptionFilterResolver;
    this.socketAuthChecker = options.socketAuthChecker;
  }

  // ---------------------------------------------------------------------------
  // Authentication lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Mark a socket as being in the authentication phase.
   * @param socket - The socket beginning authentication
   */
  public addAuthenticating(socket: WebSocketLike): void {
    this.authenticatingClients.add(socket);
  }

  /**
   * Remove a socket from the authentication-phase set.
   * @param socket - The socket that completed (or failed) authentication
   */
  public removeAuthenticating(socket: WebSocketLike): void {
    this.authenticatingClients.delete(socket);
  }

  /**
   * Check whether a socket is still in the authentication phase.
   * @param socket - Socket to check
   * @returns `true` if the socket has not yet completed authentication
   */
  public isAuthenticating(socket: WebSocketLike): boolean {
    return this.authenticatingClients.has(socket);
  }

  // ---------------------------------------------------------------------------
  // Client lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Add a fully-authenticated socket to the connected clients set.
   * @param socket - The authenticated socket.
   * @param connectionId - Optional server-generated connection identity.
   */
  public addClient(socket: WebSocketLike, connectionId?: string): void {
    this.clients.add(socket);
    if (connectionId !== undefined) this.clientsByConnectionId.set(connectionId, socket);
  }

  /**
   * Remove a socket from routing, optionally retaining one retiring response.
   *
   * Safe to call on sockets that were never fully added (e.g. auth failures).
   * @param socket - The socket to remove
   * @param reply - Route reserved for a final response to this socket.
   * @returns Aggregate subscription updates produced by removing the client
   */
  public removeClient(socket: WebSocketLike, reply?: TransportRequestOrigin): ClientSubscriptionUpdate[] {
    for (const [connectionId, client] of this.clientsByConnectionId) {
      if (client === socket) this.clientsByConnectionId.delete(connectionId);
    }
    const affectedSubjects = new Set(this.clientSubscriptionState.get(socket)?.keys() ?? []);
    this.clients.delete(socket);
    this.authenticatingClients.delete(socket);
    this.deferredSubscriptions.delete(socket);
    this.clientSubscriptions.delete(socket);
    this.clientSubscriptionState.delete(socket);
    this.clientFilters.delete(socket);
    for (const [correlationId, origin] of this.requestOrigins) {
      if (origin.socket !== socket || (reply !== undefined && origin.handle === reply)) continue;
      this.clearRequestOrigin(correlationId, origin);
    }

    if (this.debug) {
      console.info(`[ClientRegistry] Client removed (${this.clients.size} remaining)`);
    }

    return this.buildAggregateUpdates(affectedSubjects);
  }

  /**
   * Return the number of fully connected (authenticated) clients.
   * @returns Client count
   */
  public get size(): number {
    return this.clients.size;
  }

  /**
   * Check current membership when sending to a previously selected client.
   * @param socket - Candidate socket.
   * @returns Whether the socket is still registered.
   */
  public hasClient(socket: WebSocketLike): boolean {
    return this.clients.has(socket);
  }

  /**
   * Return all sockets tracked by this registry, including sockets still
   * authenticating or holding a final response.
   *
   * Used by `ServerTransport.disconnect()` to close every outstanding socket.
   * @returns Set containing all tracked sockets
   */
  public getAllSockets(): Set<WebSocketLike> {
    const sockets = new Set([...this.clients, ...this.authenticatingClients]);
    for (const origin of this.requestOrigins.values()) if (origin.retirement !== undefined) sockets.add(origin.socket);
    return sockets;
  }

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

  /**
   * Get the deferred advertisements awaiting admission for this socket.
   * @param socket - Socket owning the advertisements.
   * @returns The per-client replay state.
   */
  public deferredSubscriptionsFor(socket: WebSocketLike): DeferredSubscriptionReplay {
    let replay = this.deferredSubscriptions.get(socket);
    if (replay === undefined) {
      replay = new DeferredSubscriptionReplay(socket);
      this.deferredSubscriptions.set(socket, replay);
    }
    return replay;
  }

  /**
   * Stage routing changes and capture the previous entries for the affected patterns.
   * @param client - Socket whose subscriptions are changing.
   * @param message - Effective subscription update after admission.
   * @param pending - Patterns deferred by this update.
   * @returns Aggregate updates and a rollback that republishes restored routes.
   */
  public stageSubscriptionUpdate(
    client: WebSocketLike,
    message: BusSubscribeMessage | BusUnsubscribeMessage,
    pending: Record<string, number[]>,
  ): StagedSubscriptionUpdate {
    const removed = message.type === 'subscribe' ? pending : message.subjects;
    const affected = new Set([...Object.keys(removed), ...Object.keys(message.subjects)]);
    const previous = [...affected].map((pattern) => ({
      pattern,
      state: this.clientSubscriptionState.get(client)?.get(pattern),
      filter: this.clientFilters.get(client)?.get(pattern),
    }));
    const restore = (): boolean => {
      if (!this.clients.has(client)) return false;
      const subs = this.clientSubscriptions.get(client);
      const states = this.clientSubscriptionState.get(client);
      const filters = this.clientFilters.get(client);
      for (const { pattern, state, filter } of previous) {
        if (state === undefined) {
          subs?.delete(pattern);
          states?.delete(pattern);
        } else {
          subs?.add(pattern);
          states?.set(pattern, state);
        }
        if (filter === undefined) filters?.delete(pattern);
        else filters?.set(pattern, filter);
      }
      return true;
    };

    try {
      const updates = this.handleUnsubscribeMessage(client, removed);
      if (message.type === 'subscribe') updates.push(...this.handleSubscribeMessage(client, message));
      return { updates, rollback: () => (restore() ? this.buildAggregateUpdates(affected) : []) };
    } catch (error) {
      restore();
      throw error;
    }
  }

  /**
   * Apply a subscribe message to the per-client tracking state.
   *
   * Adds subjects to the client's subscription set and records any per-subject
   * payload filters. When a subject is (re-)subscribed without a filter, any
   * previously stored filter for that subject is removed to prevent stale
   * server-side filtering.
   * @param client - The WebSocket client
   * @param message - Subscribe message with subjects and optional filters
   * @returns Aggregate subscription replacements for the affected subjects
   */
  public handleSubscribeMessage(client: WebSocketLike, message: BusSubscribeMessage): ClientSubscriptionUpdate[] {
    let subs = this.clientSubscriptions.get(client);
    if (!subs) {
      subs = new Set();
      this.clientSubscriptions.set(client, subs);
    }

    let filters = this.clientFilters.get(client);
    let subscriptionState = this.clientSubscriptionState.get(client);
    if (!subscriptionState) {
      subscriptionState = new Map();
      this.clientSubscriptionState.set(client, subscriptionState);
    }

    for (const [subject, priorities] of Object.entries(message.subjects)) {
      subs.add(subject);
      subscriptionState.set(subject, {
        priorities,
        deliveryClass: message.deliveryClasses?.[subject] === 'relayable' ? 'relayable' : 'first-hop-only',
      });
      const newFilter = message.filters?.[subject];
      if (newFilter !== undefined) {
        if (!filters) {
          filters = new Map<string, PayloadFilter>();
          this.clientFilters.set(client, filters);
        }
        filters.set(subject, newFilter);
      } else {
        filters?.delete(subject);
      }
    }

    if (this.debug) {
      const subjectCount = Object.keys(message.subjects).length;
      const filterCount = message.filters ? Object.keys(message.filters).length : 0;
      console.info(`[ClientRegistry] Client subscribed to ${subjectCount} subjects, ${filterCount} filters`);
    }

    return this.buildAggregateUpdates(new Set(Object.keys(message.subjects)));
  }

  /**
   * Apply an unsubscribe message to the per-client tracking state.
   * @param client - The WebSocket client
   * @param subjects - Map of subject patterns to priorities being removed
   * @returns Aggregate replacements or final unsubscriptions for the affected subjects
   */
  public handleUnsubscribeMessage(
    client: WebSocketLike,
    subjects: Record<string, number[]>,
  ): ClientSubscriptionUpdate[] {
    const subs = this.clientSubscriptions.get(client);
    const filters = this.clientFilters.get(client);

    for (const subject of Object.keys(subjects)) {
      subs?.delete(subject);
      this.clientSubscriptionState.get(client)?.delete(subject);
      filters?.delete(subject);
    }

    if (this.debug) {
      console.info(`[ClientRegistry] Client unsubscribed from ${Object.keys(subjects).length} subjects`);
    }

    return this.buildAggregateUpdates(new Set(Object.keys(subjects)));
  }

  // ---------------------------------------------------------------------------
  // Routing helpers
  // ---------------------------------------------------------------------------

  /**
   * Collect all connected clients with open (`readyState === 1`) sockets.
   * @returns Array of ready clients
   */
  public getReadyClients(): WebSocketLike[] {
    const result: WebSocketLike[] = [];
    for (const client of this.clients) {
      if (client.readyState === 1) {
        result.push(client);
      }
    }
    return result;
  }

  /**
   * Return the connected socket for a server-generated connection ID.
   * @param connectionId - Server-generated connection identity.
   * @returns The ready authenticated socket, if it remains connected.
   */
  public getClientByConnectionId(connectionId: string): WebSocketLike | undefined {
    const client = this.clientsByConnectionId.get(connectionId);
    return client !== undefined && this.isReadyAndAuthenticated(client) ? client : undefined;
  }

  /**
   * Associate an accepted inbound request with its requesting socket.
   *
   * The association is single-use and lasts for the request's remaining relative
   * budget. Requests with `timeout: 0` have no expiry and remain tracked until a
   * response, cancellation, or socket removal.
   * @param socket - Socket that submitted the request
   * @param request - Accepted inbound request envelope
   * @param wireCorrelationId - Peer correlation before replacement with a local identifier.
   * @returns Response handle for a locally correlated exchange request.
   */
  public trackRequestOrigin(
    socket: WebSocketLike,
    request: BusRequestMessage,
    wireCorrelationId?: string,
  ): TransportRequestOrigin | undefined {
    const { correlationId } = request;
    if (this.requestOrigins.has(correlationId)) return;

    const remainingLifetime = this.getRequestRemainingLifetime(request);
    // Defensive: a non-positive budget would arm a timer that fires immediately.
    if (remainingLifetime !== undefined && remainingLifetime <= 0) return;

    const origin: RequestOrigin = {
      socket,
      handle: wireCorrelationId === undefined ? undefined : Object.freeze({ correlationId }),
      wireCorrelationId,
      expiration: undefined,
    };
    if (remainingLifetime !== undefined) {
      origin.expiration = setTimeout(() => {
        if (this.requestOrigins.get(correlationId) === origin) {
          this.cancelRequestOrigin(correlationId);
        }
      }, remainingLifetime);
    }
    this.requestOrigins.set(correlationId, origin);
    return origin.handle;
  }

  /**
   * Reserve only the committing request's response before detaching its socket.
   * @param socket - Retiring connection.
   * @param reply - Locally issued request origin.
   * @param close - Native socket close, run after handoff or when the route expires.
   * @returns Cleanup for a native disconnect, if a response was reserved.
   */
  public reserveFinalResponse(socket: WebSocketLike, reply: TransportRequestOrigin, close: () => void) {
    const { correlationId } = reply;
    const origin = this.requestOrigins.get(correlationId);
    if (origin === undefined || origin.handle !== reply || origin.socket !== socket) return undefined;
    // One second gives the local handler and receipt read time to hand off the response.
    const timer = setTimeout(() => this.cancelRequestOrigin(correlationId), FINAL_RESPONSE_HANDOFF_MS);
    origin.retirement = {
      deadline: performance.now() + FINAL_RESPONSE_HANDOFF_MS,
      finish: () => {
        clearTimeout(timer);
        close();
      },
    };
    return () => this.cancelRequestOrigin(correlationId);
  }

  /**
   * Read the requesting socket without consuming its response route.
   *
   * Request forwarding uses this to avoid routing a request back to the peer
   * that submitted it. The entry remains live until the correlated response,
   * cancellation, deadline, or socket removal consumes it.
   * @param correlationId - Request correlation identifier.
   * @returns Originating socket, or `undefined` when the request originated locally.
   */
  public getRequestOrigin(correlationId: string): WebSocketLike | undefined {
    return this.requestOrigins.get(correlationId)?.socket;
  }

  /**
   * Take the single-use response route, including a reserved retirement handoff.
   * @param correlationId - Host-local correlation identifier.
   * @returns The original route if still tracked.
   */
  public takeResponseOrigin(correlationId: string): RequestOrigin | undefined {
    const origin = this.requestOrigins.get(correlationId);
    if (origin === undefined) return undefined;
    this.clearRequestOrigin(correlationId, origin);
    return origin.retirement !== undefined || this.isReadyAndAuthenticated(origin.socket) ? origin : undefined;
  }

  /**
   * Remove the response route for a cancelled inbound request.
   * @param correlationId - Cancelled request correlation identifier
   */
  public cancelRequestOrigin(correlationId: string): void {
    const origin = this.requestOrigins.get(correlationId);
    if (origin === undefined) return;
    this.clearRequestOrigin(correlationId, origin);
    origin.retirement?.finish();
  }

  /**
   * Collect all connected clients interested in a given subject/payload.
   *
   * When a `subscriptionSubjectRestrictionResolver` is configured, clients
   * whose authenticated identity restricts their advertised subscriptions are
   * excluded when the outbound subject does not match that set of patterns. This provides
   * defense-in-depth for the inbound subscription authorization.
   * @param subject - The message subject (if any)
   * @param payload - The message payload (if any)
   * @param exclude - Optional client to exclude (e.g. the sender in cross-client event forwarding)
   * @param subscription - Explicit advertisement required for this delivery.
   * @returns Array of interested, ready clients
   */
  public getInterestedClients(
    subject: string | undefined,
    payload: unknown,
    exclude?: WebSocketLike,
    subscription?: DeliverySubscription,
  ): WebSocketLike[] {
    const result: WebSocketLike[] = [];
    for (const client of this.clients) {
      if (client === exclude || !this.isReadyAndAuthenticated(client)) continue;
      if (!this.matchesDelivery(client, subject, payload, subscription)) continue;
      result.push(client);
    }
    return result;
  }

  /**
   * Apply the current subscription and identity restrictions to a delivery candidate.
   * @param client - Candidate recipient.
   * @param subject - Concrete subject being delivered, when present.
   * @param payload - Payload as sent over the wire.
   * @param subscription - Explicit advertisement required for this delivery.
   * @returns Whether the live subscription and identity restrictions permit delivery.
   */
  public matchesDelivery(
    client: WebSocketLike,
    subject: string | undefined,
    payload: unknown,
    subscription: DeliverySubscription = 'any',
  ): boolean {
    const advertised =
      subscription === 'any' ||
      (subject !== undefined &&
        [...(this.clientSubscriptionState.get(client) ?? [])].some(
          ([pattern, state]) => state.priorities.length > 0 && matchesSubscription(subject, pattern),
        ));
    return (
      this.clients.has(client) &&
      advertised &&
      this.clientWantsMessage(client, subject, payload) &&
      this.isSubjectAllowedForClient(client, subject) &&
      this.isPayloadAllowedForClient(client, subject, payload)
    );
  }

  /**
   * Collect clients that advertised a matching request handler.
   *
   * Unlike event delivery, requests never use the no-subscription catch-all
   * behavior. A socket is a request target only when its current subscription
   * and payload filter match; identity subject restrictions remain an
   * additional authorization gate.
   * @param subject - Full request subject.
   * @param payload - Request payload used for subscription filter matching.
   * @param exclude - Optional origin socket that must not receive its own request.
   * @returns Interested, authorized request targets in connection order.
   */
  public getInterestedRequestClients(subject: string, payload: unknown, exclude?: WebSocketLike): WebSocketLike[] {
    return this.getInterestedClients(subject, payload, exclude, 'handler');
  }

  // ---------------------------------------------------------------------------
  // Cross-client forwarding
  // ---------------------------------------------------------------------------

  /**
   * Forward an event from one client to all other interested clients.
   *
   * The transport registry's relay excludes the source transport to prevent
   * loops, so cross-client forwarding within the same `ServerTransport` must
   * happen here. The sender is excluded to avoid echo.
   * @param sender - The client that emitted the event
   * @param message - The event message to forward
   * @param sendSafely - Callback to send serialized data to a specific client
   */
  public forwardEventToClients(
    sender: WebSocketLike,
    message: BusMessage,
    sendSafely: (client: WebSocketLike, data: string) => void,
  ): void {
    const subject = getSubjectFromBusMessage(message) ?? undefined;
    const payload = 'payload' in message ? message.payload : undefined;
    const serialized = JSON.stringify(message);
    const interested = this.getInterestedClients(subject, payload, sender);
    for (const client of interested) {
      sendSafely(client, serialized);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a client wants to receive a message given its subscriptions
   * and filters.
   * @param client - The WebSocket client
   * @param subject - The message subject (if any)
   * @param payload - The message payload (if any)
   * @returns `true` if the client should receive the message
   */
  private clientWantsMessage(client: WebSocketLike, subject: string | undefined, payload: unknown): boolean {
    if (subject === undefined) return true;
    const subs = this.clientSubscriptions.get(client);
    if (subs === undefined || subs.size === 0) return this.unsubscribedDelivery === 'deliver';
    const filters = this.clientFilters.get(client) ?? new Map<string, PayloadFilter>();
    return shouldReceiveMessage(subject, payload, subs, filters);
  }

  /**
   * Check whether a client can receive an outbound frame at this instant.
   * @param client - Client socket to evaluate
   * @returns `true` when the socket is open and remains authenticated
   */
  private isReadyAndAuthenticated(client: WebSocketLike): boolean {
    if (client.readyState !== 1) return false;
    if (!this.socketAuthChecker || this.socketAuthChecker(client)) return true;

    // Match the inbound expired-auth lifecycle: reject the socket immediately
    // and let its close listener remove all associated registry state.
    if (client.readyState === 1) client.close(1008, 'Authentication expired');
    return false;
  }

  /**
   * Compute the remaining response-routing lifetime for an inbound request.
   *
   * Derived from the relative `timeout` only. The wire `deadline` is an absolute
   * instant on the *sender's* clock, so comparing it against ours would drop the
   * response route for a request that still has its full budget whenever a client's
   * clock trails the server's by more than the timeout — the response would then have
   * no socket to return to. The relative budget is clock-independent and is what every
   * other hop anchors from.
   * @param request - Accepted request envelope
   * @returns Remaining milliseconds, or `undefined` for no-timeout requests
   */
  private getRequestRemainingLifetime(request: BusRequestMessage): number | undefined {
    // Resolved exactly as the bus resolves the budget it dispatches this request
    // with, so the route lives as long as the request can.
    const timeout = resolveInboundRequestBudget(request.timeout) ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return timeout > 0 ? timeout : undefined;
  }

  /**
   * Clear an origin entry and its deadline timer.
   * @param correlationId - Origin correlation identifier
   * @param origin - Current origin entry
   */
  private clearRequestOrigin(correlationId: string, origin: RequestOrigin): void {
    if (origin.expiration !== undefined) clearTimeout(origin.expiration);
    this.requestOrigins.delete(correlationId);
  }

  /**
   * Defense-in-depth: check whether the outgoing subject is allowed for a
   * client whose authenticated identity may declare subscription subject
   * restrictions.
   *
   * When no `subscriptionSubjectRestrictionResolver` is configured, or the
   * resolver returns `null` (unrestricted identity), the check passes. When
   * the resolver returns a restriction list, the outgoing subject must match
   * one of its subscription patterns.
   *
   * The resolver is called on every outbound check — not cached — so
   * revocations and rotations are reflected immediately.
   * @param client - The WebSocket client.
   * @param subject - The outgoing message subject (if any).
   * @returns `true` when the subject is allowed (or no restriction applies).
   */
  private isSubjectAllowedForClient(client: WebSocketLike, subject: string | undefined): boolean {
    if (!this.subscriptionSubjectRestrictionResolver || subject === undefined) return true;
    const allowed = this.subscriptionSubjectRestrictionResolver(client);
    if (allowed === null) return true;
    return [...allowed].some((pattern) => matchesSubscription(subject, pattern));
  }

  /**
   * Check server-owned recipient policy after advertised-subscription matching.
   *
   * This final check intentionally does not depend on subscription state: the
   * default empty-subscription fallback must not make an attempt-addressed
   * event or broadcast visible to a different authenticated identity.
   * @param client - Candidate outbound recipient.
   * @param subject - The outgoing full subject, if any.
   * @param payload - The outgoing payload.
   * @returns `true` when no required filter applies or the payload matches it.
   */
  private isPayloadAllowedForClient(client: WebSocketLike, subject: string | undefined, payload: unknown): boolean {
    if (!this.requiredSubscriptionFilterResolver || subject === undefined) return true;
    const requiredFilter = this.requiredSubscriptionFilterResolver(client)?.[subject];
    return requiredFilter === undefined || matchesFilter(payload, requiredFilter);
  }

  /**
   * Build authoritative transport-level control updates for affected subjects.
   * @param affectedSubjects - Subjects whose per-client membership changed
   * @returns Aggregate subscribe replacements and final unsubscriptions
   */
  private buildAggregateUpdates(affectedSubjects: Set<string>): ClientSubscriptionUpdate[] {
    const subjects: Record<string, number[]> = {};
    const deliveryClasses: Record<string, SubscriptionDeliveryClass> = {};
    const removedSubjects: Record<string, number[]> = {};

    for (const subject of affectedSubjects) {
      const priorities = new Set<number>();
      let hasSubscription = false;
      let deliveryClass: SubscriptionDeliveryClass = 'relayable';

      for (const subscriptions of this.clientSubscriptionState.values()) {
        const state = subscriptions.get(subject);
        if (!state) continue;
        hasSubscription = true;
        for (const priority of state.priorities) priorities.add(priority);
        if (state.deliveryClass === 'first-hop-only') deliveryClass = 'first-hop-only';
      }

      if (hasSubscription) {
        subjects[subject] = [...priorities].sort((left, right) => right - left);
        deliveryClasses[subject] = deliveryClass;
      } else {
        removedSubjects[subject] = [];
      }
    }

    const updates: ClientSubscriptionUpdate[] = [];
    if (Object.keys(subjects).length > 0) {
      updates.push({ type: 'subscribe', subjects, deliveryClasses });
    }
    if (Object.keys(removedSubjects).length > 0) {
      updates.push({ type: 'unsubscribe', subjects: removedSubjects });
    }
    return updates;
  }
}
