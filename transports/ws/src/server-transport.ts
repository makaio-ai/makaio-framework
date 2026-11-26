/**
 * Server-mode WebSocket transport implementation.
 */

import type { WebSocketLike, WebSocketServerLike, TransportAuth } from './types.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  NO_BOUNDARY_ACCESS_CHECK,
  type BoundaryAccessPolicy,
  type BusBroadcastMessage,
  type BusMessage,
  type BusReceiveHandler,
  type BusRequestMessage,
  type BusTransportError,
  type BusTransport,
  type SubscriptionDeliveryClass,
  getSubjectFromBusMessage,
  BusAbortError,
  CorrelationTracker,
} from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import { BroadcastAggregator } from './broadcast-aggregator.js';
import { buildSubscribeMessage, buildUnsubscribeMessage, type SubscriptionEntry } from './subscribe-message.js';
import { authorizedRecipients, projectBoundaryMessage, ServerBoundaryAccess } from './server-boundary-access.js';
import { ClientRegistry } from './client-registry.js';
import { setupClientConnection, routeRequestToClients } from './server-client-setup.js';
import { ConnectionExchangeAuth } from './auth/connection-exchange-auth.js';
import {
  resolveHmacIdentityAllowedSubscriptionSubjects,
  resolveHmacIdentityRequiredSubscriptionFilters,
} from './auth/identity-secret-registry.js';

export interface ServerTransportOptions {
  websocket: WebSocketServerLike;
  /**
   * Transport identity used as the registry key when registered on a bus.
   * @defaultValue 'websocket'
   */
  name?: string;
  auth?: TransportAuth;
  /** Host authorization policy or an explicit opt-out. */
  checkBoundaryAccess: BoundaryAccessPolicy;
  debug?: boolean;
}

/**
 * Server-mode WebSocket transport.
 *
 * Manages multiple client connections and broadcasts messages to all connected clients.
 * @example
 * ```typescript
 * import { NO_BOUNDARY_ACCESS_CHECK } from '@makaio/bus-core';
 * import { WebSocketServer } from 'ws';
 *
 * const wss = new WebSocketServer({ host: '127.0.0.1', port: 8080 });
 * const transport = new ServerTransport({
 *   websocket: wss,
 *   // This example runs a private loopback server without a host rights directory.
 *   checkBoundaryAccess: NO_BOUNDARY_ACCESS_CHECK,
 * });
 *
 * await transport.connect();
 * ```
 */
export class ServerTransport implements BusTransport {
  /** Transport identity used as the registry key when registered on a bus. */
  public readonly name: string;

  private readonly wss: WebSocketServerLike;
  private readonly auth: TransportAuth | undefined;
  private readonly debug: boolean;

  private readonly handlers = new Set<BusReceiveHandler>();
  private readonly registry: ClientRegistry;
  private readonly access: ServerBoundaryAccess | undefined;

  /** Server-local handler subjects + priorities, advertised to connected clients. */
  private readonly serverSubscriptions = new Map<string, SubscriptionEntry>();

  private readonly broadcastAggregator: BroadcastAggregator;
  private readonly correlations = new WeakMap<WebSocketLike, CorrelationTracker>();
  /** Cancellation handles of in-flight server-initiated requests, keyed by the caller's correlation ID. */
  private readonly requestRoutes = new Map<string, AbortController>();

  private connectionListener: ((socket: WebSocketLike) => void) | null = null;
  private readonly connectionClosedHandlers = new Set<(connectionId: string) => void>();

  /**
   * @param options - Server transport configuration
   */
  public constructor(options: ServerTransportOptions) {
    const { websocket, name = 'websocket', auth, debug = false, checkBoundaryAccess } = options;
    if (checkBoundaryAccess !== NO_BOUNDARY_ACCESS_CHECK && typeof checkBoundaryAccess !== 'function') {
      throw new TypeError('WebSocket server requires checkBoundaryAccess or NO_BOUNDARY_ACCESS_CHECK');
    }
    this.wss = websocket;
    this.name = name;
    this.auth = auth;
    this.debug = debug;
    this.access =
      checkBoundaryAccess === NO_BOUNDARY_ACCESS_CHECK
        ? undefined
        : new ServerBoundaryAccess(name, auth, checkBoundaryAccess);
    const resolveForSocket =
      <T>(resolvePolicy: (identityId: string) => T) =>
      (client: WebSocketLike): T | null => {
        const identityId = auth?.getAuthenticatedIdentityId?.(client);
        return identityId === undefined ? null : resolvePolicy(identityId);
      };
    this.registry = new ClientRegistry({
      debug,
      unsubscribedDelivery: checkBoundaryAccess === NO_BOUNDARY_ACCESS_CHECK ? 'deliver' : 'drop',
      subscriptionSubjectRestrictionResolver: auth
        ? resolveForSocket(resolveHmacIdentityAllowedSubscriptionSubjects)
        : undefined,
      requiredSubscriptionFilterResolver: auth
        ? resolveForSocket(resolveHmacIdentityRequiredSubscriptionFilters)
        : undefined,
      socketAuthChecker: auth ? (client) => auth.isSocketAuthenticated?.(client) ?? true : undefined,
    });
    this.broadcastAggregator = new BroadcastAggregator({ debug });
  }

  /**
   * Send serialized data to a client without letting one socket failure disrupt fan-out.
   * @param client - Target client socket
   * @param data - Serialized message payload
   * @returns Whether the frame was sent on an open socket.
   */
  private sendToClientSafely(client: WebSocketLike, data: string): boolean {
    if (client.readyState !== 1) return false;
    try {
      client.send(data);
      return true;
    } catch (error) {
      if (this.debug) {
        console.warn('[ServerTransport] Failed to send message to client:', error);
      }
      return false;
    }
  }

  /**
   * Start listening for client connections.
   * @throws Error when called while the transport is already connected
   */
  public async connect(): Promise<void> {
    if (this.connectionListener !== null) {
      throw new Error('ServerTransport.connect() called while already connected');
    }

    this.connectionListener = (socket: WebSocketLike): void => {
      const correlations = new CorrelationTracker();
      this.correlations.set(socket, correlations);
      void setupClientConnection(socket, {
        registry: this.registry,
        correlations,
        broadcastAggregator: this.broadcastAggregator,
        handlers: this.handlers,
        auth: this.auth,
        access: this.access,
        serverSubscriptions: this.serverSubscriptions,
        sendSafely: (client, data) => this.sendToClientSafely(client, data),
        debug: this.debug,
        onConnectionClosed: (connectionId) => {
          for (const handler of this.connectionClosedHandlers) handler(connectionId);
        },
      });
    };
    this.wss.on('connection', this.connectionListener);

    if (this.debug) {
      console.info('[ServerTransport] Listening for connections');
    }
  }

  /**
   * Stop listening and disconnect all clients.
   */
  public async disconnect(): Promise<void> {
    if (this.connectionListener) {
      this.wss.off('connection', this.connectionListener);
      this.connectionListener = null;
    }

    // Native close events may arrive after shutdown has started.
    if (this.auth instanceof ConnectionExchangeAuth) this.auth.abortPendingExchanges();
    const socketsToClose = this.registry.getAllSockets();
    for (const client of socketsToClose) {
      client.close();
    }
    // Sockets are removed from the registry individually in close handlers.
    // Clearing registry state here would let late messages bypass the
    // authenticating-client guard before close events fire.

    await new Promise<void>((resolve, reject) => {
      this.wss.close((err?: Error) => (err ? reject(err) : resolve()));
    });

    this.broadcastAggregator.cleanup();
    this.auth?.cleanup();
    this.handlers.clear();
    this.serverSubscriptions.clear();

    if (this.debug) {
      console.info('[ServerTransport] Disconnected');
    }
  }

  /**
   * Send a broadcast message to all interested clients and aggregate responses.
   * @param message - Broadcast message to fan out
   * @param timeout - Broadcast response aggregation timeout in milliseconds. Use `0` to disable automatic timeout and
   * finalization, which can leave the returned promise pending until every target client responds or disconnects
   * @returns Promise resolving to aggregated results from all responding handlers
   */
  public send(message: BusBroadcastMessage, timeout?: number): Promise<Array<{ nodeId: string; payload: unknown }>>;
  /**
   * Send a request to connected clients and return the first response.
   * @param message - Request message
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to the handler response payload
   */
  public send(message: BusRequestMessage, timeout?: number): Promise<unknown>;
  /**
   * Send an event or other message to all interested clients.
   * @param message - Bus message to deliver
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to `true` if delivered to at least one client, `false` otherwise
   */
  public send(message: BusMessage, timeout?: number): Promise<boolean>;
  /**
   * Send a message to connected clients.
   *
   * **Behavior by message type:**
   * - **Requests** (`BusRequestMessage`): Sends to first interested client and waits for response.
   * Returns the response payload from the handler. Throws if no clients available.
   * - **Broadcasts** (`BusBroadcastMessage`): Sends to all interested clients and aggregates responses.
   * Returns array of results from all handlers that responded.
   * - **Events/Other**: Broadcasts to all interested clients. Returns delivery status boolean.
   *
   * For requests, routing considers only clients with matching subscriptions
   * that remain authorized for the subject.
   * For events, subscription-based filtering is applied for efficiency.
   * @param message - The bus message to send
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to response data (requests), aggregated results (broadcasts), or delivery status (events)
   */
  public async send(message: BusMessage, timeout?: number): Promise<unknown> {
    if (message.type === 'response') {
      const client = this.registry.consumeResponseClient(message.correlationId);
      if (!client) return false;
      this.sendToClientSafely(client, JSON.stringify(message));
      return true;
    }

    // Handle server-initiated broadcasts with response aggregation
    if (message.type === 'broadcast') {
      const subject = getSubjectFromBusMessage(message) ?? undefined;
      const projected = projectBoundaryMessage(message);
      const interestedClients = await authorizedRecipients(
        { access: this.access, registry: this.registry },
        this.registry.getInterestedClients(subject, projected.payload),
        projected,
      );

      return this.broadcastAggregator.startServerBroadcast(
        { ...projected, correlationId: globalThis.crypto.randomUUID() },
        interestedClients(),
        (client, data) => this.sendToClientSafely(client, data),
        timeout,
      );
    }

    // Handle server-initiated requests with subject-authorized routing.
    if (message.type === 'request') {
      return this.routeRequest(projectBoundaryMessage(message), timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
    }

    return this.deliverMessage(message);
  }

  /**
   * Deliver an unsolicited message to its authorized recipients.
   * @param message - Outbound event or control message.
   * @returns Whether a socket received it.
   */
  private async deliverMessage(message: BusMessage): Promise<boolean> {
    // Server mode: broadcast to all connected clients (for non-broadcast, non-request messages)
    if (this.registry.size === 0) {
      // Response delivery is best-effort: the requester may have disconnected
      // before the local handler finished. Events/heartbeats are also no-ops.
      if (this.debug) {
        const subject = getSubjectFromBusMessage(message);
        console.debug(`[ServerTransport] No clients to receive ${message.type}${subject ? `: ${subject}` : ''}`);
      }
      return false;
    }

    const subject = getSubjectFromBusMessage(message) ?? undefined;
    const projected = message.type === 'event' ? projectBoundaryMessage(message) : message;
    const payload = 'payload' in projected ? projected.payload : undefined;
    const candidates = this.registry.getInterestedClients(subject, payload);
    const recipients =
      projected.type === 'event'
        ? await authorizedRecipients({ access: this.access, registry: this.registry }, candidates, projected)
        : () => candidates;
    const serialized = JSON.stringify(projected);
    const interested = recipients();
    for (const client of interested) {
      this.sendToClientSafely(client, serialized);
    }
    const sentToAny = interested.length > 0;

    if (!sentToAny) {
      if (subject && this.debug) console.warn(`[ServerTransport] No interested clients for subject: ${subject}`);

      // it's valid to have no interested clients -> only throw if there are no clients at all
      if (!subject) {
        throw new Error('No connected clients available to receive message');
      }
    }

    return sentToAny;
  }

  /**
   * Route a server-initiated request so the caller can cancel it by its own correlation ID.
   *
   * Client attempts are tracked under attempt-scoped correlation IDs, so
   * cancellation reaches the in-flight attempt through this route's signal.
   * @param message - Request envelope
   * @param timeout - Total routing budget in milliseconds; `0` means no automatic timeout
   * @returns Response payload from the handling client
   */
  private async routeRequest(message: BusRequestMessage, timeout: number): Promise<unknown> {
    const route = new AbortController();
    this.requestRoutes.set(message.correlationId, route);
    try {
      return await routeRequestToClients(message, timeout, {
        registry: this.registry,
        correlationsFor: (client) => this.correlations.get(client),
        signal: route.signal,
        access: this.access,
      });
    } finally {
      if (this.requestRoutes.get(message.correlationId) === route) this.requestRoutes.delete(message.correlationId);
    }
  }

  /**
   * Deliver an event to exactly one server-generated WebSocket connection.
   * @param message - Event to deliver.
   * @param connectionId - Server-generated connection identity.
   * @returns Whether the target is still connected and received the event.
   */
  public async sendToConnection(
    message: Extract<BusMessage, { type: 'event' }>,
    connectionId: string,
  ): Promise<boolean> {
    const client = this.registry.getClientByConnectionId(connectionId);
    if (client === undefined) return false;
    const projected = projectBoundaryMessage(message);
    const stillConnected = (): boolean => this.registry.getClientByConnectionId(connectionId) === client;
    const revalidate = this.access
      ? await this.access.authorizeDelivery(projected, client, stillConnected)
      : stillConnected;
    const frame = JSON.stringify(projected);
    return Boolean(revalidate?.()) && this.sendToClientSafely(client, frame);
  }

  /**
   * Subscribe to server-owned WebSocket connection teardown.
   * @param handler - Called after a connection is no longer routable.
   * @returns Unsubscribe function.
   */
  public onConnectionClosed(handler: (connectionId: string) => void): () => void {
    this.connectionClosedHandlers.add(handler);
    return () => this.connectionClosedHandlers.delete(handler);
  }

  /**
   * Register a handler for incoming messages from clients.
   * @param handler - Handler function for incoming messages
   * @returns Unsubscribe function
   */
  public onReceive(handler: BusReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Cancel a pending correlated request.
   *
   * A server-initiated request rejects its in-flight client attempt and is not
   * routed to further clients. A request accepted from a client loses its
   * response route.
   * @param correlationId - Correlation ID to cancel
   * @param error - Optional cancellation error
   */
  public cancelRequest(correlationId: string, error?: Error): void {
    this.requestRoutes.get(correlationId)?.abort(error ?? new BusAbortError(undefined));
    this.registry.cancelRequestOrigin(correlationId);
  }

  /**
   * Receive aggregated broadcast results from the transport registry.
   *
   * Called directly by the transport registry after executing local handlers
   * and relay transports for a client-initiated broadcast, replacing the
   * legacy send() side-channel.
   * @param correlationId - Correlation ID of the originating broadcast
   * @param results - Aggregated results from local handlers and relay transports
   * @param error - Optional structured error propagated to the originator
   */
  public onBroadcastResults(
    correlationId: string,
    results: ReadonlyArray<{ nodeId: string; payload: unknown }>,
    error?: BusTransportError,
  ): void {
    this.broadcastAggregator.handleNodeResults(correlationId, results, error);
  }

  /**
   * Advertise a server-local handler to all connected WebSocket clients.
   *
   * Called by the transport registry when a handler registers on this bus via
   * `bus.on()`. The full accumulated priority set for the subject is received
   * (replace semantics, not incremental).
   * @param subject - Subject pattern
   * @param filter - Optional payload filter
   * @param priorities - Handler priorities for priority-based dispatch
   * @param deliveryClass - Whether the subscription may be advertised beyond its direct peer
   */
  public async subscribe(
    subject: string,
    filter?: PayloadFilter,
    priorities: number[] = [],
    deliveryClass?: SubscriptionDeliveryClass,
  ): Promise<void> {
    const existing = this.serverSubscriptions.get(subject);
    const existingFilter = existing?.filter;
    const resolvedFilter = filter ?? existingFilter;
    const resolvedDeliveryClass = deliveryClass ?? existing?.deliveryClass ?? 'relayable';
    this.serverSubscriptions.set(subject, {
      filter: resolvedFilter,
      priorities,
      deliveryClass: resolvedDeliveryClass,
    });

    if (this.registry.size > 0) {
      const message = buildSubscribeMessage(
        new Map([[subject, { filter: resolvedFilter, priorities, deliveryClass: resolvedDeliveryClass }]]),
      );
      const serialized = JSON.stringify(message);
      for (const client of this.registry.getReadyClients()) {
        this.sendToClientSafely(client, serialized);
      }
    }
  }

  /**
   * Return the number of currently authenticated and connected clients.
   *
   * Clients that are still in the authentication phase are not counted.
   * @returns Number of fully connected clients
   */
  public getConnectionCount(): number {
    return this.registry.getReadyClients().length;
  }

  /**
   * Remove a server-local handler advertisement from all connected clients.
   * @param subject - Subject pattern to unsubscribe
   */
  public async unsubscribe(subject: string): Promise<void> {
    this.serverSubscriptions.delete(subject);

    if (this.registry.size > 0) {
      const message = buildUnsubscribeMessage({ [subject]: [] });
      const serialized = JSON.stringify(message);
      for (const client of this.registry.getReadyClients()) {
        this.sendToClientSafely(client, serialized);
      }
    }
  }

  // NOTE: getSubscriptions is intentionally NOT implemented on ServerTransport.
  // ServerTransport represents many clients — routing is delegated to send()
  // which correctly filters per-client via getInterestedClients(). Per-client
  // subscription state is accessed internally via clientSubscriptions.
  // Server-local handler advertisements are tracked in serverSubscriptions and
  // are pushed to clients via subscribe()/unsubscribe().
}
