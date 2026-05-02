/**
 * Server-mode WebSocket transport implementation.
 */

import type { WebSocketLike, WebSocketServerLike, TransportAuth } from './types.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type BusBroadcastMessage,
  type BusMessage,
  type BusReceiveHandler,
  type BusRequestMessage,
  type BusTransportError,
  type BusTransport,
  getSubjectFromBusMessage,
  CorrelationTracker,
} from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import { BroadcastAggregator } from './broadcast-aggregator.js';
import { buildSubscribeMessage, buildUnsubscribeMessage, type SubscriptionEntry } from './subscribe-message.js';
import { ClientRegistry } from './client-registry.js';
import { setupClientConnection, routeRequestToClients } from './server-client-setup.js';

export interface ServerTransportOptions {
  websocket: WebSocketServerLike;
  /**
   * Transport identity used as the registry key when registered on a bus.
   * @defaultValue 'websocket'
   */
  name?: string;
  auth?: TransportAuth;
  debug?: boolean;
}

/**
 * Server-mode WebSocket transport.
 *
 * Manages multiple client connections and broadcasts messages to all connected clients.
 * @example
 * ```typescript
 * import { WebSocketServer } from 'ws';
 *
 * const wss = new WebSocketServer({ port: 8080 });
 * const transport = new ServerTransport({
 *   websocket: wss,
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

  /** Server-local handler subjects + priorities, advertised to connected clients. */
  private readonly serverSubscriptions = new Map<string, SubscriptionEntry>();

  private readonly broadcastAggregator: BroadcastAggregator;
  private readonly correlations = new CorrelationTracker();

  private connectionListener: ((socket: WebSocketLike) => void) | null = null;

  /**
   * @param options - Server transport configuration
   */
  public constructor(options: ServerTransportOptions) {
    const { websocket, name = 'websocket', auth, debug = false } = options;
    this.wss = websocket;
    this.name = name;
    this.auth = auth;
    this.debug = debug;
    this.registry = new ClientRegistry({ debug });
    this.broadcastAggregator = new BroadcastAggregator({ debug });
  }

  /**
   * Send serialized data to a client without letting one socket failure disrupt fan-out.
   * @param client - Target client socket
   * @param data - Serialized message payload
   */
  private sendToClientSafely(client: WebSocketLike, data: string): void {
    try {
      client.send(data);
    } catch (error) {
      if (this.debug) {
        console.warn('[ServerTransport] Failed to send message to client:', error);
      }
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
      void setupClientConnection(socket, {
        registry: this.registry,
        correlations: this.correlations,
        broadcastAggregator: this.broadcastAggregator,
        handlers: this.handlers,
        auth: this.auth,
        serverSubscriptions: this.serverSubscriptions,
        sendSafely: (client, data) => this.sendToClientSafely(client, data),
        debug: this.debug,
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

    this.correlations.cleanup();
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
   * For requests, routing is **unfiltered** — all connected clients are tried.
   * For events, subscription-based filtering is applied for efficiency.
   * @param message - The bus message to send
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to response data (requests), aggregated results (broadcasts), or delivery status (events)
   */
  public async send(message: BusMessage, timeout?: number): Promise<unknown> {
    // Handle server-initiated broadcasts with response aggregation
    if (message.type === 'broadcast') {
      const subject = getSubjectFromBusMessage(message) ?? undefined;
      const payload = 'payload' in message ? message.payload : undefined;

      // Find interested clients
      const interestedClients = this.registry.getInterestedClients(subject, payload);

      return this.broadcastAggregator.startServerBroadcast(
        message,
        interestedClients,
        (client, data) => {
          // Keep per-client send failures isolated from the rest of the broadcast.
          this.sendToClientSafely(client, data);
        },
        timeout,
      );
    }

    // Handle server-initiated requests — unfiltered routing to all connected clients
    if (message.type === 'request') {
      return routeRequestToClients(message, timeout ?? DEFAULT_REQUEST_TIMEOUT_MS, {
        registry: this.registry,
        correlations: this.correlations,
      });
    }

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
    const payload = 'payload' in message ? message.payload : undefined;
    const serialized = JSON.stringify(message);

    const interested = this.registry.getInterestedClients(subject, payload);
    for (const client of interested) {
      this.sendToClientSafely(client, serialized);
    }
    const sentToAny = interested.length > 0;

    if (!sentToAny) {
      if (subject && this.debug) console.warn(`[ServerTransport] No interested clients for subject: ${subject}`);

      // Response delivery is best-effort because the original requester may
      // have disconnected after dispatch but before the handler completed.
      if (message.type === 'response') {
        return false;
      }

      // it's valid to have no interested clients -> only throw if there are no clients at all
      if (!subject) {
        throw new Error('No connected clients available to receive message');
      }
    }

    return sentToAny;
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
   * Cancel a pending correlated server-initiated request.
   * @param correlationId - Correlation ID to cancel
   * @param error - Optional cancellation error
   */
  public cancelRequest(correlationId: string, error?: Error): void {
    this.correlations.cancel(correlationId, error);
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
   */
  public async subscribe(subject: string, filter?: PayloadFilter, priorities: number[] = []): Promise<void> {
    const existingFilter = this.serverSubscriptions.get(subject)?.filter;
    const resolvedFilter = filter ?? existingFilter;
    this.serverSubscriptions.set(subject, { filter: resolvedFilter, priorities });

    if (this.registry.size > 0) {
      const message = buildSubscribeMessage(new Map([[subject, { filter: resolvedFilter, priorities }]]));
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
