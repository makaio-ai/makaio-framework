/**
 * URL-based WebSocket client transport with built-in reconnection.
 *
 * Takes a URL and manages the full connection lifecycle — socket creation,
 * authentication, subscription replay, and exponential-backoff reconnection.
 */

import type { WebSocketLike, TransportAuth, ClientTransportCodec } from './types.js';
import { ConnectionLostError, CorrelationTracker } from '@makaio/bus-core';
import { type SubscriptionEntry } from './subscribe-message.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type BusBroadcastMessage,
  type BusMessage,
  type BusReceiveHandler,
  type BusRequestMessage,
  type BusTransport,
  type SubscriptionDeliveryClass,
} from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import { type WebSocketClientTransportReconnectOptions } from './ws-client-reconnect.js';
import {
  DEFAULT_CODEC,
  DEFAULT_CONNECT_TIMEOUT_MS,
  resolveHeartbeatConfig,
  resolveReconnectConfig,
  type WebSocketClientTransportHeartbeatOptions,
  type WebSocketClientTransportOptions,
} from './ws-client-options.js';
import {
  connectOnce,
  runReconnectLoop,
  removeSocketListeners,
  installNoReconnectCloseListener,
  type ConnectionDeps,
} from './ws-client-connection.js';
import { addSubscription, removeSubscription, type SubscriptionAckHandle } from './ws-client-subscriptions.js';
import { disposeSocket } from './transport-helpers.js';
import { WebSocketConnectionError } from './connection-error.js';
import { ClientSocketSession } from './ws-client-socket-session.js';
import { sendClientMessage } from './ws-client-send.js';

// Re-export public types so that consumers and index.ts can import them
// from this module's path without needing to know the sub-module layout.
export type { WebSocketClientTransportHeartbeatOptions, WebSocketClientTransportOptions } from './ws-client-options.js';
export type { WebSocketClientTransportReconnectOptions } from './ws-client-reconnect.js';

/**
 * URL-based WebSocket client transport with built-in reconnection.
 *
 * Takes a URL and owns the full connection lifecycle — socket creation,
 * authentication, subscription replay, and exponential-backoff reconnection.
 * Callers never create or pass a `WebSocket` directly.
 * @example
 * ```typescript
 * const transport = new WebSocketClientTransport({ url: 'ws://localhost:8080/bus' });
 * await transport.connect();
 * await transport.subscribe('adapter.*');
 * ```
 */
export class WebSocketClientTransport implements BusTransport {
  /** Transport identity for the bus registry. */
  public readonly name: string;

  private readonly url: string;
  private readonly auth: TransportAuth | undefined;
  private readonly codec: ClientTransportCodec;
  private readonly messageTransform: ((message: BusMessage) => Promise<BusMessage>) | undefined;
  private readonly autoReconnectConfig: Required<WebSocketClientTransportReconnectOptions> | false;
  private readonly heartbeatConfig: Required<WebSocketClientTransportHeartbeatOptions> | false;
  private readonly connectTimeoutMs: number;
  private readonly wsFactory: (url: string) => WebSocketLike | Promise<WebSocketLike>;
  private readonly debug: boolean;
  private readonly onConnectedCallback: (() => void) | undefined;
  private readonly onDisconnectedCallback: (() => void) | undefined;

  private session: ClientSocketSession | null = null;
  private authComplete = false;

  private readonly correlations = new CorrelationTracker();
  private readonly handlers = new Set<BusReceiveHandler>();
  private readonly localSubscriptions = new Map<string, SubscriptionEntry>();
  private readonly pendingSubscriptionAcks = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  private subscriptionAckSeq = 0;

  private messageListener: ((event: { data: string | Buffer }) => void) | null = null;
  private closeListener: ((event: unknown) => void) | null = null;

  /** Owns initial connection and its reconnect loop; `null` when disconnected. */
  private reconnectAbort: AbortController | null = null;

  /**
   * In-flight `handleInboundMessage` promises for the current socket session.
   *
   * Drained and cleared at the start of each connection attempt so that the
   * drain-before-rejectAll logic in `drainAndRejectPendingCorrelations` only
   * waits on the promises belonging to the active session.
   */
  private inFlightMessages = new Set<Promise<void>>();

  /** AbortController for the current backoff sleep; aborting wakes the sleep early. */
  private backoffWakeAbort: AbortController | null = null;

  /**
   * Whether `runReconnectLoop` is currently executing.
   * Used by `reconnect()` to distinguish a loop mid-attempt (rescue a hung
   * socket-open wait) from an in-flight or failed initial connect (no-op —
   * `connect()` owns recovery there).
   */
  private reconnectLoopRunning = false;

  /** Resolver for the current ready promise; `null` once resolved. */
  private readyResolve: (() => void) | null = null;

  /** Resolves when the subscribe-sync-complete handshake is received; reset on each reconnect. */
  public ready: Promise<void>;

  /** Set by the transport registry to track each session's ready promise for dispatch gating. */
  public onNewReadySession: ((promise: Promise<void>) => void) | undefined = undefined;

  /** Set by the transport registry; called after auth + subscription replay on each connect. */
  public onConnected: (() => void) | undefined = undefined;

  /** Set by the transport registry; called when the connection drops unexpectedly. */
  public onDisconnected: (() => void) | undefined = undefined;

  /**
   * Current socket remains owned during buffered reply drain, even after termination.
   * @returns The retained socket, or null after its release.
   */
  private get socket(): WebSocketLike | null {
    return this.session?.socket ?? null;
  }

  /**
   * Create a new `WebSocketClientTransport`.
   * @param options - Transport configuration
   */
  public constructor(options: WebSocketClientTransportOptions) {
    this.url = options.url;
    this.name = options.name ?? 'ws-client';
    this.auth = options.auth;
    this.codec = options.codec ?? DEFAULT_CODEC;
    this.messageTransform = options.messageTransform;
    this.debug = options.debug ?? false;
    this.autoReconnectConfig = resolveReconnectConfig(options.autoReconnect);
    this.heartbeatConfig = resolveHeartbeatConfig(options.heartbeat);
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.wsFactory = options.createWebSocket ?? this.defaultWsFactory;
    this.onConnectedCallback = options.onConnected;
    this.onDisconnectedCallback = options.onDisconnected;

    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
  }

  /**
   * Connect to the bus server, authenticate, replay subscriptions, and start
   * the reconnect loop if enabled.
   * @returns Promise that resolves when the initial connection is established
   */
  public async connect(): Promise<void> {
    if (this.reconnectAbort !== null) {
      throw new Error('WebSocketClientTransport: already connected');
    }

    const abort = new AbortController();
    this.reconnectAbort = abort;

    try {
      await connectOnce(this.connectionDeps(), abort.signal);
    } catch (error) {
      if (this.reconnectAbort === abort) this.reconnectAbort = null;
      throw error;
    }

    if (abort.signal.aborted || this.reconnectAbort !== abort) {
      throw new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'WebSocket connection cancelled');
    }

    if (this.autoReconnectConfig !== false) {
      void this.startReconnectLoop(abort.signal);
    } else if (this.socket !== null) {
      this.wireNoReconnectClose(this.socket);
    }
  }

  /**
   * Disconnect and clean up: stops the reconnect loop, closes the socket,
   * and releases auth, correlation, and handler state.
   * @returns Promise that resolves when the transport is fully disconnected
   */
  public async disconnect(): Promise<void> {
    const abort = this.reconnectAbort;
    const socketBeforeAbort = this.socket;
    this.reconnectAbort = null;
    abort?.abort(new WebSocketConnectionError('WS_CONNECTION_UNAVAILABLE', 'WebSocket connection cancelled'));
    // An in-flight attempt releases its owned auth synchronously on abort.
    const cleanupAuth = socketBeforeAbort === null || this.socket === socketBeforeAbort;
    this.reconnectLoopRunning = false;
    this.backoffWakeAbort = null;

    this.readyResolve?.();
    this.readyResolve = null;

    if (this.socket !== null) {
      removeSocketListeners(this.socket, this.connectionDeps());
      const ws = this.socket;
      this.session?.release();
      this.authComplete = false;
      disposeSocket(ws);
    }

    this.correlations.rejectAll(this.session?.failure ?? new ConnectionLostError(this.name));
    this.rejectPendingSubscriptionAcks(new Error('WebSocketClientTransport: disconnected before subscription ack'));
    // Auth strategies own pending handshakes, timers, and derived session
    // keys. The client transport owns the strategy lifecycle, so every
    // explicit disconnect must release that state before the instance can be
    // reused for a later connection.
    if (cleanupAuth) this.auth?.cleanup();
    this.handlers.clear();

    if (this.debug) {
      console.info(`[WebSocketClientTransport:${this.name}] Disconnected`);
    }
  }

  /**
   * Send a message over the WebSocket connection.
   * @param message - Bus message to send
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to response (requests), results array (broadcasts), or boolean (events)
   */
  public async send<TMessage extends BusMessage>(
    message: TMessage,
    timeout?: number,
  ): Promise<
    TMessage extends BusRequestMessage
      ? unknown
      : TMessage extends BusBroadcastMessage
        ? Array<{ nodeId: string; payload: unknown }>
        : boolean
  > {
    return sendClientMessage(
      {
        session: this.session,
        currentSession: () => this.session,
        name: this.name,
        codec: this.codec,
        correlations: this.correlations,
      },
      message,
      timeout ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  /**
   * Register a handler for all inbound messages.
   * @param handler - Invoked for each decoded inbound message with optional receive context
   * @returns Unsubscribe function
   */
  public onReceive(handler: BusReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Subscribe to a subject on the server with an optional payload filter.
   *
   * Buffers the subscription for reconnect replay. Sends immediately when the
   * socket is open. See {@link addSubscription} for full semantics.
   * @param subject - Subject pattern (supports wildcards like `'adapter.*'`)
   * @param filter - Optional payload filter for server-side smart-routing
   * @param priorities - Handler priorities registered for this subject
   * @param deliveryClass - Whether the subscription may be advertised beyond its direct peer
   * @returns Promise that resolves when buffering (and optional send) is complete
   */
  public async subscribe(
    subject: string,
    filter?: PayloadFilter,
    priorities: number[] = [],
    deliveryClass?: SubscriptionDeliveryClass,
  ): Promise<void> {
    await addSubscription(subject, filter, priorities, deliveryClass, this.subscriptionDeps());
  }

  /**
   * Unsubscribe from a subject on the server.
   *
   * Removes the subject from the replay buffer. Sends immediately when the
   * socket is open. See {@link removeSubscription} for full semantics.
   * @param subject - Subject to unsubscribe from
   * @returns Promise that resolves when the removal (and optional send) is complete
   */
  public async unsubscribe(subject: string): Promise<void> {
    await removeSubscription(subject, this.subscriptionDeps());
  }

  /** @returns Set of subject patterns currently subscribed. */
  public getSubscriptions(): Set<string> {
    return new Set(this.localSubscriptions.keys());
  }

  /**
   * Cancel a pending correlated request.
   * @param correlationId - Correlation ID to cancel
   * @param error - Optional cancellation error
   */
  public cancelRequest(correlationId: string, error?: Error): void {
    this.correlations.cancel(correlationId, error);
  }

  /**
   * Returns `true` when the socket is open (`readyState === 1`) and auth has completed.
   * @returns `true` if the transport can send messages
   */
  public isReady(): boolean {
    return this.socket !== null && this.socket.readyState === 1 && this.authComplete;
  }

  /**
   * Trigger an immediate reconnection attempt.
   *
   * Cancels an active backoff wait, rescues a hung in-flight connect attempt
   * by closing its still-CONNECTING socket (the loop then backs off and
   * retries), or performs a one-shot connect when auto-reconnect is disabled.
   * @returns Promise that resolves when the attempt is initiated (loop) or completes (one-shot)
   */
  public async reconnect(): Promise<void> {
    if (this.isReady()) return;
    if (this.backoffWakeAbort !== null) {
      this.backoffWakeAbort.abort();
      this.backoffWakeAbort = null;
      return;
    }
    if (this.autoReconnectConfig !== false) {
      if (this.reconnectLoopRunning) {
        // Loop mid-attempt. If the attempt hangs waiting for the socket to
        // open, closing the socket settles `waitForSocketOpen` so the loop
        // fails the attempt, backs off, and retries — the escape hatch for a
        // never-settling upgrade. Every phase is also bounded by the shared
        // connectTimeoutMs attempt budget.
        const socket = this.socket;
        if (socket !== null && socket.readyState === 0) {
          socket.close();
        }
        return;
      }
      // Loop not running: an initial connect() is either still in flight (it
      // starts the loop itself on success and is bounded by connectTimeoutMs)
      // or it failed and the caller owns recovery via connect(). Starting a
      // loop here would race the in-flight connect with a second loop.
      return;
    }
    try {
      if (this.reconnectAbort === null) await this.connect();
    } catch {
      // Suppress: transport was already disconnected; don't double-emit disconnected.
    }
  }

  /**
   * Start the background reconnect loop; thin wrapper around `runReconnectLoop`.
   * @param signal - AbortSignal that stops the loop (fires on `disconnect()`)
   * @returns Promise that resolves when the loop exits (signal aborted)
   */
  private startReconnectLoop(signal: AbortSignal): Promise<void> {
    return runReconnectLoop(
      signal,
      this.autoReconnectConfig as Required<WebSocketClientTransportReconnectOptions>,
      this.connectionDeps(),
      (ctrl) => {
        if (!signal.aborted) this.backoffWakeAbort = ctrl;
      },
      (running) => {
        if (this.reconnectAbort?.signal === signal) this.reconnectLoopRunning = running;
      },
    );
  }

  /**
   * Build a `SubscriptionDeps` snapshot for the subscription helpers.
   * @returns Subscription dependency context bound to this transport instance
   */
  private subscriptionDeps() {
    return {
      name: this.name,
      debug: this.debug,
      codec: this.codec,
      socket: this.socket,
      localSubscriptions: this.localSubscriptions,
      beginSubscriptionAck: () => this.beginSubscriptionAck(),
    };
  }

  /**
   * Track one dynamic subscription update until the remote peer acknowledges it.
   * @returns Ack identifier, pending promise, and cleanup reject callback.
   */
  private beginSubscriptionAck(): SubscriptionAckHandle {
    const ackId = `${this.name}:sub:${++this.subscriptionAckSeq}`;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);

    const settle = (settler: () => void): void => {
      if (!this.pendingSubscriptionAcks.has(ackId)) return;
      this.pendingSubscriptionAcks.delete(ackId);
      settler();
    };

    this.pendingSubscriptionAcks.set(ackId, {
      resolve: () => settle(resolve),
      reject: (error) => settle(() => reject(error)),
    });

    return {
      ackId,
      promise,
      reject: (error) => this.rejectSubscriptionAck(ackId, error),
    };
  }

  /**
   * Resolve a pending dynamic subscription acknowledgement.
   * @param ackId - Ack identifier received from the peer.
   */
  private resolveSubscriptionAck(ackId: string): void {
    this.pendingSubscriptionAcks.get(ackId)?.resolve();
  }

  /**
   * Reject one pending dynamic subscription acknowledgement.
   * @param ackId - Ack identifier to reject.
   * @param error - Rejection reason.
   */
  private rejectSubscriptionAck(ackId: string, error: unknown): void {
    this.pendingSubscriptionAcks.get(ackId)?.reject(error);
  }

  /**
   * Reject all pending subscription acknowledgements for a closing socket session.
   * @param error - Rejection reason.
   */
  private rejectPendingSubscriptionAcks(error: Error): void {
    for (const ackId of this.pendingSubscriptionAcks.keys()) {
      this.rejectSubscriptionAck(ackId, error);
    }
  }

  /**
   * Build the `ConnectionDeps` context for connection lifecycle helpers.
   * @returns Connection dependency context bound to this transport instance
   */
  private connectionDeps(): ConnectionDeps {
    return {
      name: this.name,
      debug: this.debug,
      auth: this.auth,
      codec: this.codec,
      messageTransform: this.messageTransform,
      correlations: this.correlations,
      handlers: this.handlers,
      localSubscriptions: this.localSubscriptions,
      wsFactory: this.wsFactory,
      url: this.url,
      connectTimeoutMs: this.connectTimeoutMs,
      heartbeat: this.heartbeatConfig,
      getSocket: () => this.socket,
      setSocket: (ws, failure) => {
        this.session?.release(failure);
        if (ws !== null) this.session = new ClientSocketSession(ws, this.name);
      },
      getSessionFailure: () => this.session?.failure,
      setAuthComplete: (value) => {
        this.authComplete = value;
      },
      getMessageListener: () => this.messageListener,
      setMessageListener: (listener) => {
        this.messageListener = listener;
      },
      getCloseListener: () => this.closeListener,
      setCloseListener: (listener) => {
        this.closeListener = listener;
      },
      resolveReady: () => {
        this.readyResolve?.();
        this.readyResolve = null;
      },
      resetReadyPromise: () => {
        let resolveOwnReady!: () => void;
        this.ready = new Promise<void>((resolve) => {
          this.readyResolve = resolve;
          resolveOwnReady = resolve;
        });
        const finishOwnReady = (): void => {
          resolveOwnReady();
          if (this.readyResolve === resolveOwnReady) this.readyResolve = null;
        };
        try {
          this.onNewReadySession?.(this.ready);
        } catch (error) {
          finishOwnReady();
          throw error;
        }
        return finishOwnReady;
      },
      resolveSubscriptionAck: (ackId) => {
        this.resolveSubscriptionAck(ackId);
      },
      rejectPendingSubscriptionAcks: (error) => {
        this.rejectPendingSubscriptionAcks(error);
      },
      notifyConnected: () => {
        const socket = this.socket;
        this.onConnectedCallback?.();
        if (socket !== null && this.socket === socket && this.isReady()) this.onConnected?.();
      },
      notifyDisconnected: () => {
        this.onDisconnectedCallback?.();
        this.onDisconnected?.();
      },
      inFlightMessages: this.inFlightMessages,
    };
  }

  /**
   * Default `ws`-package WebSocket factory (dynamic import avoids bundling in browsers).
   *
   * The connection lifecycle owns the single timeout budget, including this
   * import and socket creation. A second protocol timer would race its typed
   * outcome and give callers an unstable failure category.
   * @param url - WebSocket server URL
   * @returns Promise resolving to a `WebSocketLike` instance
   */
  private readonly defaultWsFactory = async (url: string): Promise<WebSocketLike> => {
    const wsModule = await import('ws');
    return new wsModule.WebSocket(url) as WebSocketLike;
  };

  /**
   * Wire the no-reconnect close listener; resets `reconnectAbort` on close
   * so `connect()` can be called again.
   * @param ws - The connected socket to watch for closure
   */
  private wireNoReconnectClose(ws: WebSocketLike): void {
    installNoReconnectCloseListener(ws, this.connectionDeps(), () => {
      this.reconnectAbort = null;
    });
  }
}
