/**
 * Transport layer interfaces for cross-process bus communication.
 *
 * Transports enable the bus to communicate across process boundaries
 * via WebSocket, NATS, Redis, HTTP, etc.
 */

import type { PayloadFilter, TransportReceiveContext } from '@makaio/core';

/**
 * Subscribe message for client subscription management.
 *
 * Supports both subject-based filtering (wildcards) and payload-based filtering
 * (declarative filter specs). Both are applied server-side for smart-routing.
 *
 * Priority arrays enable cross-transport priority-based dispatch: the receiver
 * uses the arrays to populate its remote handler registry so that dispatch can
 * consider handler priorities across process boundaries.
 * @example
 * ```typescript
 * // Request handler with priorities
 * { type: 'subscribe', subjects: { 'ui.navigate': [100, 200] } }
 *
 * // Event-only handler (no priority-based dispatch)
 * { type: 'subscribe', subjects: { 'session.created': [] } }
 * ```
 */
export interface BusSubscribeMessage {
  type: 'subscribe';
  /**
   * Subjects and their handler priorities.
   * Keys are subject patterns (can include wildcards like `'adapter.*'`).
   * Values are arrays of handler priorities registered for that subject.
   * An empty array indicates event-only handlers with no priority-based dispatch.
   */
  subjects: Record<string, number[]>;
  /**
   * Optional payload filters per subject.
   * Key is the subject pattern, value is the filter to apply.
   * Messages are only forwarded if payload matches the filter.
   * @example
   * ```typescript
   * {
   *   subjects: { 'mcp.event': [] },
   *   filters: {
   *     'mcp.event': { agentId: 'agent-123' }
   *   }
   * }
   * ```
   */
  filters?: Record<string, PayloadFilter>;
}

/**
 * Unsubscribe message for client subscription management.
 *
 * Priority arrays enable ref-counted unsubscription: the receiver removes only
 * the listed handler priorities from its remote handler registry rather than
 * wiping the entire subject entry.
 */
export interface BusUnsubscribeMessage {
  type: 'unsubscribe';
  /**
   * Subjects and the handler priorities being removed.
   * Keys are subject patterns.
   * Values are the specific priorities being unregistered (for ref-counting).
   * An empty array removes the subject entirely (no handlers remain).
   */
  subjects: Record<string, number[]>;
}

/**
 * Subscribe-sync-complete handshake message.
 *
 * Sent by the bus to a newly registered transport after the current handler
 * subscriptions have been pushed. The recipient resolves its `ready` promise
 * upon receipt, signalling that priority-based request dispatch may safely
 * route through the transport.
 */
export interface BusSubscribeSyncCompleteMessage {
  type: 'subscribe-sync-complete';
}

/**
 * Message types for transport wire protocol.
 */
export type BusMessage =
  | BusRequestMessage
  | BusResponseMessage
  | BusEventMessage
  | BusBroadcastMessage
  | BusBroadcastResponseMessage
  | BusHeartbeatMessage
  | BusSubscribeMessage
  | BusUnsubscribeMessage
  | BusSubscribeSyncCompleteMessage;

/**
 * Handler invoked by transports when a bus message arrives.
 *
 * The optional receive context is trusted local metadata supplied by the
 * receiving transport. It must not be serialized or relayed to other nodes.
 */
export type BusReceiveHandler = (message: BusMessage, context?: TransportReceiveContext) => Promise<void>;

/**
 * Heartbeat message for connection keep-alive.
 */
export interface BusHeartbeatMessage {
  type: 'heartbeat';
  timestamp: number;
}

/**
 * Request message sent over transport.
 */
export interface BusRequestMessage {
  type: 'request';
  subject: string;
  namespace: string;
  payload: unknown;
  correlationId: string;
  messageId: string;
  /**
   * Caller-specified request timeout in milliseconds.
   *
   * Propagated across relay hops so intermediate transport registries use the
   * same timeout policy as the original caller.
   * A value of `0` means no automatic timeout.
   */
  timeout?: number;
  /**
   * Priority cursor for cross-transport priority-based dispatch.
   *
   * When set, dispatch considers only handlers with a priority strictly below
   * this value, enabling the chain to continue from where a previous hop left off.
   * Omitted on the first dispatch hop (meaning start from the highest priority).
   */
  priority?: number;
  /**
   * Absolute dispatch deadline as a Unix timestamp in milliseconds (`Date.now() + timeout`).
   *
   * Set on the first dispatch hop and propagated through all subsequent hops so
   * that each hop can compute its remaining time budget without relying on the
   * original timeout value alone.
   */
  deadline?: number;
}

/**
 * Structured error payload for transport responses.
 */
export interface BusTransportError {
  /** Human-readable error message */
  message: string;
  /** Error code for programmatic handling (e.g., 'IMPORT_CONFLICT') */
  code?: string;
  /**
   * Subject this error pertains to.
   * Preserved for {@link NoHandlerError} so that `isNoHandlerErrorForSubject`
   * can match without fragile message-string comparisons after a
   * serialize → deserialize round-trip.
   */
  subject?: string;
  /** Additional error data (e.g., conflicts, orphans) */
  data?: Record<string, unknown>;
}

/**
 * Response message sent over transport.
 */
export interface BusResponseMessage {
  type: 'response';
  correlationId: string;
  result?: unknown;
  error?: BusTransportError;
}

/**
 * Event message sent over transport.
 */
export interface BusEventMessage {
  type: 'event';
  subject: string;
  namespace: string;
  payload: unknown;
  messageId: string;
  correlationId?: string;
}

/**
 * Broadcast request message sent over transport.
 *
 * Unlike regular requests (single response), broadcasts expect
 * multiple responses aggregated into an array.
 */
export interface BusBroadcastMessage {
  type: 'broadcast';
  subject: string;
  namespace: string;
  payload: unknown;
  correlationId: string;
  messageId: string;
  /**
   * Caller-specified broadcast timeout in milliseconds.
   *
   * Propagated across relay hops so relayed broadcast collection preserves the
   * original caller timeout contract.
   * A value of `0` means no automatic timeout.
   */
  timeout?: number;
}

/**
 * Broadcast response message sent over transport.
 *
 * Contains an array of results from all handlers that responded.
 */
export interface BusBroadcastResponseMessage {
  type: 'broadcast-response';
  correlationId: string;
  results?: Array<{ nodeId: string; payload: unknown }>;
  error?: BusTransportError;
}

/**
 * Transport interface for bus communication.
 *
 * Transports handle serialization, wire protocol, and connection management
 * for cross-process communication.
 * @example
 * ```typescript
 * class WebSocketTransport implements BusTransport {
 *   readonly name = 'websocket';
 *
 *   async send(message: BusMessage): Promise<void> {
 *     this.ws.send(JSON.stringify(message));
 *   }
 *
 *   onReceive(handler: BusReceiveHandler): () => void {
 *     const listener = (data) => {
 *       const message = JSON.parse(data) as BusMessage;
 *       const context: TransportReceiveContext = { transportName: this.name };
 *       void handler(message, context);
 *     };
 *     this.ws.on('message', listener);
 *     return () => this.ws.off('message', listener);
 *   }
 *
 *   async connect(): Promise<void> {
 *     await this.ws.connect();
 *   }
 *
 *   async disconnect(): Promise<void> {
 *     await this.ws.close();
 *   }
 * }
 * ```
 */
export interface BusTransport {
  /**
   * Unique transport name used as the registry key.
   *
   * The name is used by `IMakaioBus.registerTransport()` to key the transport
   * in the internal registry. It must be unique within a single bus instance.
   * Implementations should declare this as a `readonly` literal or class field.
   * @example
   * ```typescript
   * class MyTransport implements BusTransport {
   *   readonly name = 'my-transport';
   * }
   * ```
   */
  name: string;
  /**
   * Send a message over the transport.
   *
   * **Behavior by message type:**
   * - **Requests** (`BusRequestMessage`): Returns the response payload from the handler.
   * Throws error if no clients available to handle request (server mode).
   * - **Events** (`BusEventMessage`): Returns delivery status boolean.
   * - `true`: Delivered to at least one recipient
   * - `false`: No recipients available (not an error)
   * - **Other messages** (heartbeat, subscribe, etc.): Returns `true` if sent successfully.
   *
   * **Error handling:**
   * - Throws when transport is disconnected
   * - Throws when sending requests with no connected clients (server mode only)
   * - Never throws for events - returns `false` instead
   *
   * **Timeout contract:**
   * The `timeout` value flows from the caller's `bus.request({ timeout })` option
   * through the dispatch layer to the transport's correlation tracker.
   * A value of `0` means no automatic timeout — the promise stays open until
   * resolved or rejected externally (e.g. by the caller's own AbortSignal).
   * @param message - Message to send
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to response payload (requests) or delivery status (events/other)
   * @example
   * ```typescript
   * // Request: type-safe response handling
   * const request: BusRequestMessage = {
   *   type: 'request',
   *   subject: 'user.get',
   *   namespace: 'api',
   *   payload: { id: 123 },
   *   correlationId: 'req-1',
   *   messageId: 'msg-1',
   * };
   * const response = await transport.send(request, 5000); // response: unknown
   *
   * // Event: delivery status
   * const event: BusEventMessage = {
   *   type: 'event',
   *   subject: 'user.created',
   *   namespace: 'api',
   *   payload: { id: 123 },
   *   messageId: 'evt-1',
   * };
   * const delivered = await transport.send(event, 0); // delivered: boolean
   * if (!delivered) {
   *   console.warn('Event not delivered - no subscribers');
   * }
   * ```
   */
  send<TMessage extends BusMessage>(
    message: TMessage,
    timeout?: number,
  ): Promise<
    TMessage extends BusRequestMessage
      ? unknown
      : TMessage extends BusBroadcastMessage
        ? Array<{ nodeId: string; payload: unknown }>
        : boolean
  >;

  /**
   * Optional: cancel/cleanup pending correlation state for an in-flight request.
   *
   * Used when the caller aborts while the transport-level correlation promise is
   * still pending (e.g. timeout `0` + AbortSignal). Implementations should reject
   * and remove the correlation entry if present.
   * @param correlationId - Correlation ID to cancel
   * @param error - Optional cancellation error to propagate
   */
  cancelRequest?(correlationId: string, error?: Error): void;

  /**
   * Register a handler for incoming messages.
   * @param handler - Handler function
   * @returns Unsubscribe function
   */
  onReceive(handler: BusReceiveHandler): () => void;

  /**
   * Connect the transport.
   */
  connect(): Promise<void>;

  /**
   * Disconnect the transport.
   */
  disconnect(): Promise<void>;

  /**
   * Optional: Trigger an immediate reconnection attempt, bypassing any backoff wait.
   *
   * If the transport is currently waiting in an exponential-backoff delay, calling
   * this wakes it immediately so a new connection attempt starts without waiting.
   * If reconnection is disabled on the transport, a one-shot connect attempt is made.
   * No-op when the transport is already connected.
   * @returns Promise that resolves when the attempt is initiated or completes
   */
  reconnect?(): Promise<void>;

  /**
   * Optional: Promise that resolves when the transport is fully operational
   * (end-to-end, including remote handler availability).
   *
   * Resolved after the bus has sent the initial subscribe sync to the transport
   * and the transport has received the {@link BusSubscribeSyncCompleteMessage}
   * handshake. Before this resolves, `remoteRequestHandlers` for this transport
   * may be incomplete and requests should not be routed through it.
   *
   * Transports that do not implement `ready` are considered immediately ready.
   * @remarks
   * Transports that do not implement `onNewReadySession` are single-use:
   * after `disconnect()` completes, a later `connect()` call has undefined
   * behavior. Reconnectable transports must call `onNewReadySession` each time
   * they create a new `ready` promise so the registry can update its gating.
   */
  ready?: Promise<void>;

  /**
   * Optional callback set by the transport registry during registration.
   * Transports that support reconnection call this at the start of each
   * new session so the registry can track the new ready promise for
   * dispatch gating.
   * @param promise - The new ready promise for the current session
   */
  onNewReadySession?: (promise: Promise<void>) => void;

  /**
   * Optional callback set by the transport registry during registration.
   * Called each time the transport establishes a connection (initial or reconnect),
   * after authentication and subscription replay are complete.
   */
  onConnected?: () => void;

  /**
   * Optional callback set by the transport registry during registration.
   * Called when the transport loses its connection unexpectedly.
   * Not called on an explicit `disconnect()`.
   */
  onDisconnected?: () => void;

  /**
   * Optional: Synchronous readiness check for transport-level gating.
   *
   * When implemented and returning `false`, the bus skips this transport
   * for outbound sends (requests, broadcasts, events). The transport
   * continues to receive inbound messages via `onReceive`.
   *
   * Complements the async `ready` promise: `isReady()` enables non-blocking
   * skip decisions in hot paths, while `ready` supports await-based flows.
   * @returns `true` if the transport can send messages, `false` otherwise
   */
  isReady?(): boolean;

  /**
   * Optional: Report which subjects this transport is interested in.
   * Enables transport-level filtering for efficiency.
   *
   * If not implemented, the transport will receive all messages (broadcast mode).
   * If implemented, only messages matching the subscription patterns will be sent.
   *
   * Patterns can include wildcards (e.g., 'adapter.*' matches 'adapter.log', 'adapter.init', etc.)
   * @returns Set of subscription patterns (can include wildcards)
   */
  getSubscriptions?(): Set<string>;

  /**
   * Subscribe to a subject for smart-routing.
   *
   * Transports use this to track which subjects have active handlers,
   * enabling targeted message delivery instead of broadcast.
   *
   * When `priorities` is provided the transport should include the priority
   * information in the next outbound subscribe wire message for this subject,
   * enabling cross-transport priority-based dispatch on the remote side.
   * Calling this method again with a new `priorities` array replaces the
   * previously advertised set for that subject (re-subscribe semantics).
   *
   * Transports that do not need subscription management (e.g. local-only
   * loopback transports) should provide a no-op implementation.
   * @param subject - Subject pattern to subscribe to (can include wildcards)
   * @param filter - Optional payload filter for fine-grained routing
   * @param priorities - Handler priorities registered for this subject; an empty
   *   array signals event-only handlers that do not participate in priority dispatch
   */
  subscribe(subject: string, filter?: PayloadFilter, priorities?: number[]): Promise<void>;

  /**
   * Unsubscribe from a subject.
   *
   * Called when the last handler for a subject is removed, allowing the
   * transport to stop routing messages for that subject.
   *
   * Transports that do not need subscription management should provide a
   * no-op implementation.
   * @param subject - Subject pattern to unsubscribe from
   */
  unsubscribe(subject: string): Promise<void>;

  /**
   * Receive aggregated broadcast results from the transport registry.
   *
   * Called by the transport registry after executing local handlers and relaying
   * to other transports for a broadcast that arrived from this transport via
   * `onReceive`. Replaces the legacy `send({ type: 'broadcast-response' })`
   * side-channel when implemented.
   *
   * Transports that manage their own peer-level fan-out (e.g., ServerTransport
   * with multiple WebSocket clients) implement this to receive registry results
   * without abusing the `send()` contract.
   * @param correlationId - Correlation ID of the originating broadcast
   * @param results - Aggregated results from local handlers and relay transports
   * @param error - Optional structured error when broadcast processing failed;
   * results may be empty or partial in this case
   */
  onBroadcastResults?(
    correlationId: string,
    results: ReadonlyArray<{ nodeId: string; payload: unknown }>,
    error?: BusTransportError,
  ): void;
}
