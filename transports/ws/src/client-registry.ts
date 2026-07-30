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
import type { PayloadFilter } from '@makaio/core';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  getSubjectFromBusMessage,
  matchesSubscription,
  shouldReceiveMessage,
} from '@makaio/bus-core';
import type { WebSocketLike } from './types.js';

/**
 * Callback that resolves allowed subjects for a client socket.
 *
 * Returns the live restriction list when the client's authenticated identity
 * declares `allowedSubjects`, or `null` when the client is unrestricted
 * (either because the identity has no restriction, or the identity is unknown).
 *
 * Implementations should resolve from the live identity-secret-registry so
 * revocations and rotations are reflected immediately — matching the per-message
 * revalidation freshness on the inbound path.
 * @param client - The WebSocket client to resolve restrictions for.
 * @returns Allowed subjects list, or `null` when unrestricted.
 */
export type SubjectRestrictionResolver = (client: WebSocketLike) => ReadonlySet<string> | null;

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
  /**
   * Optional callback that resolves subject restrictions for a client socket.
   *
   * When provided, outbound event and broadcast forwarding skips clients whose
   * restriction list does not include the message subject. This provides
   * defense-in-depth for the inbound subscription filter.
   */
  subjectRestrictionResolver?: SubjectRestrictionResolver;
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

interface RequestOrigin {
  socket: WebSocketLike;
  expiration: ReturnType<typeof setTimeout> | undefined;
}

/** Transport-level subscription updates produced after per-client state changes. */
export type ClientSubscriptionUpdate = BusSubscribeMessage | BusUnsubscribeMessage;

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
  private readonly authenticatingClients = new Set<WebSocketLike>();
  private readonly clientSubscriptions = new Map<WebSocketLike, Set<string>>();
  private readonly clientSubscriptionState = new Map<WebSocketLike, Map<string, ClientSubscriptionState>>();
  private readonly clientFilters = new Map<WebSocketLike, Map<string, PayloadFilter>>();
  private readonly requestOrigins = new Map<string, RequestOrigin>();
  private readonly debug: boolean;
  private readonly subjectRestrictionResolver: SubjectRestrictionResolver | undefined;
  private readonly socketAuthChecker: SocketAuthChecker | undefined;

  /**
   * @param options - Registry configuration
   */
  public constructor(options: ClientRegistryOptions = {}) {
    this.debug = options.debug ?? false;
    this.subjectRestrictionResolver = options.subjectRestrictionResolver;
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
   * @param socket - The authenticated socket
   */
  public addClient(socket: WebSocketLike): void {
    this.clients.add(socket);
  }

  /**
   * Remove a socket from all tracking maps and sets.
   *
   * Safe to call on sockets that were never fully added (e.g. auth failures).
   * @param socket - The socket to remove
   * @returns Aggregate subscription updates produced by removing the client
   */
  public removeClient(socket: WebSocketLike): ClientSubscriptionUpdate[] {
    const affectedSubjects = new Set(this.clientSubscriptionState.get(socket)?.keys() ?? []);
    this.clients.delete(socket);
    this.authenticatingClients.delete(socket);
    this.clientSubscriptions.delete(socket);
    this.clientSubscriptionState.delete(socket);
    this.clientFilters.delete(socket);
    for (const [correlationId, origin] of this.requestOrigins) {
      if (origin.socket !== socket) continue;
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
   * Return all sockets tracked by this registry, including those still
   * authenticating.
   *
   * Used by `ServerTransport.disconnect()` to close every outstanding socket.
   * @returns Set containing all tracked sockets
   */
  public getAllSockets(): Set<WebSocketLike> {
    return new Set([...this.clients, ...this.authenticatingClients]);
  }

  // ---------------------------------------------------------------------------
  // Subscription management
  // ---------------------------------------------------------------------------

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
   * Associate an accepted inbound request with its requesting socket.
   *
   * The association is single-use and lasts until the request's propagated
   * deadline. Requests with `timeout: 0` have no deadline and remain tracked
   * until a response, cancellation, or socket removal.
   * @param socket - Socket that submitted the request
   * @param request - Accepted inbound request envelope
   */
  public trackRequestOrigin(socket: WebSocketLike, request: BusRequestMessage): void {
    const { correlationId } = request;
    if (this.requestOrigins.has(correlationId)) return;

    const remainingLifetime = this.getRequestRemainingLifetime(request);
    if (remainingLifetime === 0) return;

    const origin: RequestOrigin = {
      socket,
      expiration: undefined,
    };
    if (remainingLifetime !== undefined) {
      origin.expiration = setTimeout(() => {
        if (this.requestOrigins.get(correlationId) === origin) {
          this.requestOrigins.delete(correlationId);
        }
      }, remainingLifetime);
    }
    this.requestOrigins.set(correlationId, origin);
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
   * Consume the requesting socket for a correlated response.
   *
   * Responses are correlation-addressed, not subscription-addressed. A
   * restricted socket may receive its own response, but no other socket can.
   * @param correlationId - Response correlation identifier
   * @returns Eligible requesting socket, or `undefined` when none remains
   */
  public consumeResponseClient(correlationId: string): WebSocketLike | undefined {
    const origin = this.requestOrigins.get(correlationId);
    if (!origin) return undefined;

    this.clearRequestOrigin(correlationId, origin);
    return this.isReadyAndAuthenticated(origin.socket) ? origin.socket : undefined;
  }

  /**
   * Remove the response route for a cancelled inbound request.
   * @param correlationId - Cancelled request correlation identifier
   */
  public cancelRequestOrigin(correlationId: string): void {
    const origin = this.requestOrigins.get(correlationId);
    if (origin) this.clearRequestOrigin(correlationId, origin);
  }

  /**
   * Collect all connected clients interested in a given subject/payload.
   *
   * When a `subjectRestrictionResolver` is configured, clients whose
   * authenticated identity restricts them to a set of allowed subjects are
   * excluded when the outbound subject is not in that set. This provides
   * defense-in-depth for the inbound subscription filter.
   * @param subject - The message subject (if any)
   * @param payload - The message payload (if any)
   * @param exclude - Optional client to exclude (e.g. the sender in cross-client event forwarding)
   * @returns Array of interested, ready clients
   */
  public getInterestedClients(subject: string | undefined, payload: unknown, exclude?: WebSocketLike): WebSocketLike[] {
    const result: WebSocketLike[] = [];
    for (const client of this.clients) {
      if (client === exclude || !this.isReadyAndAuthenticated(client)) continue;
      if (!this.clientWantsMessage(client, subject, payload)) continue;
      if (!this.isSubjectAllowedForClient(client, subject)) continue;
      result.push(client);
    }
    return result;
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
    return this.getInterestedClients(subject, payload, exclude).filter((client) => {
      const subscriptions = this.clientSubscriptionState.get(client);
      if (!subscriptions) return false;
      return [...subscriptions].some(
        ([pattern, state]) => state.priorities.length > 0 && matchesSubscription(subject, pattern),
      );
    });
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
    const subs = this.clientSubscriptions.get(client) ?? new Set<string>();
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
    client.close(1008, 'Authentication expired');
    return false;
  }

  /**
   * Compute the remaining response-routing lifetime for an inbound request.
   * @param request - Accepted request envelope
   * @returns Remaining milliseconds, `undefined` for no-timeout requests, or `0` when expired
   */
  private getRequestRemainingLifetime(request: BusRequestMessage): number | undefined {
    if (request.deadline !== undefined) {
      return Math.max(0, request.deadline - Date.now());
    }
    const timeout = request.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
   * client whose authenticated identity may declare subject restrictions.
   *
   * When no `subjectRestrictionResolver` is configured, or the resolver
   * returns `null` (unrestricted identity), the check passes. When the
   * resolver returns a restriction list, the outgoing subject must appear
   * in that list.
   *
   * The resolver is called on every outbound check — not cached — so
   * revocations and rotations are reflected immediately.
   * @param client - The WebSocket client.
   * @param subject - The outgoing message subject (if any).
   * @returns `true` when the subject is allowed (or no restriction applies).
   */
  private isSubjectAllowedForClient(client: WebSocketLike, subject: string | undefined): boolean {
    if (!this.subjectRestrictionResolver || subject === undefined) return true;
    const allowed = this.subjectRestrictionResolver(client);
    if (allowed === null) return true;
    return allowed.has(subject);
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
