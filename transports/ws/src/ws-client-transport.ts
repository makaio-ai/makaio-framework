/**
 * URL-based WebSocket client transport with built-in reconnection.
 *
 * Takes a URL and manages the full connection lifecycle — socket creation,
 * authentication, subscription replay, and exponential-backoff reconnection.
 */

import type { WebSocketLike, TransportAuth, ClientTransportCodec } from './types.js';
import { CorrelationTracker, trackMessageCorrelation } from '@makaio/bus-core';
import { type SubscriptionEntry } from './subscribe-message.js';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type BusBroadcastMessage,
  type BusMessage,
  type BusRequestMessage,
  type BusTransport,
} from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import { type WebSocketClientTransportReconnectOptions } from './ws-client-reconnect.js';
import { DEFAULT_CODEC, resolveReconnectConfig, type WebSocketClientTransportOptions } from './ws-client-options.js';
import {
  connectOnce,
  runReconnectLoop,
  removeSocketListeners,
  installNoReconnectCloseListener,
  type ConnectionDeps,
} from './ws-client-connection.js';
import { addSubscription, removeSubscription, type SubscriptionAckHandle } from './ws-client-subscriptions.js';

// Re-export public types so that consumers and index.ts can import them
// from this module's path without needing to know the sub-module layout.
export type { WebSocketClientTransportOptions } from './ws-client-options.js';
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
  private readonly wsFactory: (url: string) => WebSocketLike | Promise<WebSocketLike>;
  private readonly debug: boolean;
  private readonly onConnectedCallback: (() => void) | undefined;
  private readonly onDisconnectedCallback: (() => void) | undefined;

  private socket: WebSocketLike | null = null;
  private authComplete = false;

  private readonly correlations = new CorrelationTracker();
  private readonly handlers = new Set<(message: BusMessage) => Promise<void>>();
  private readonly localSubscriptions = new Map<string, SubscriptionEntry>();
  private readonly pendingSubscriptionAcks = new Map<string, { resolve(): void; reject(error: unknown): void }>();
  private subscriptionAckSeq = 0;

  private messageListener: ((event: { data: string | Buffer }) => void) | null = null;
  private closeListener: ((event: unknown) => void) | null = null;

  /** AbortController for the active reconnect loop; `null` when not connected. */
  private reconnectAbort: AbortController | null = null;

  /** AbortController for the current backoff sleep; aborting wakes the sleep early. */
  private backoffWakeAbort: AbortController | null = null;

  /**
   * Whether `runReconnectLoop` is currently executing.
   * Used by `reconnect()` to distinguish mid-attempt (no-op) from loop-never-started (retry).
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
      await connectOnce(this.connectionDeps());
    } catch (error) {
      this.reconnectAbort = null;
      throw error;
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
    this.reconnectAbort = null;
    abort?.abort();

    this.readyResolve?.();
    this.readyResolve = null;

    if (this.socket !== null) {
      removeSocketListeners(this.socket, this.connectionDeps());
      const ws = this.socket;
      this.socket = null;
      this.authComplete = false;
      if (ws.readyState === 0 || ws.readyState === 1) {
        ws.close();
      }
    }

    this.correlations.cleanup();
    this.rejectPendingSubscriptionAcks(new Error('WebSocketClientTransport: disconnected before subscription ack'));
    // Auth strategies own pending handshakes, timers, and derived session
    // keys. The client transport owns the strategy lifecycle, so every
    // explicit disconnect must release that state before the instance can be
    // reused for a later connection.
    this.auth?.cleanup();
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
    if (this.socket === null || this.socket.readyState !== 1) {
      throw new Error('WebSocketClientTransport: not connected');
    }

    const payload = await this.codec.encode(message);
    this.socket.send(payload);

    return trackMessageCorrelation(message, this.correlations, timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  /**
   * Register a handler for all inbound messages.
   * @param handler - Invoked for each decoded inbound message
   * @returns Unsubscribe function
   */
  public onReceive(handler: (message: BusMessage) => Promise<void>): () => void {
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
   * @returns Promise that resolves when buffering (and optional send) is complete
   */
  public async subscribe(subject: string, filter?: PayloadFilter, priorities: number[] = []): Promise<void> {
    await addSubscription(subject, filter, priorities, this.subscriptionDeps());
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
   * Cancels an active backoff wait, starts the reconnect loop if it stalled,
   * or performs a one-shot connect when auto-reconnect is disabled.
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
      if (this.reconnectLoopRunning) return; // Loop mid-attempt — already trying.
      // Loop never started (connectOnce threw on initial connect) — start it now.
      if (this.reconnectAbort !== null) {
        void this.startReconnectLoop(this.reconnectAbort.signal);
      }
      return;
    }
    try {
      await connectOnce(this.connectionDeps());
      if (this.socket !== null) {
        this.reconnectAbort = new AbortController();
        this.wireNoReconnectClose(this.socket);
      }
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
        this.backoffWakeAbort = ctrl;
      },
      (running) => {
        this.reconnectLoopRunning = running;
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
      getSocket: () => this.socket,
      setSocket: (ws) => {
        this.socket = ws;
      },
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
        this.ready = new Promise<void>((resolve) => {
          this.readyResolve = resolve;
        });
        this.onNewReadySession?.(this.ready);
      },
      resolveSubscriptionAck: (ackId) => {
        this.resolveSubscriptionAck(ackId);
      },
      rejectPendingSubscriptionAcks: (error) => {
        this.rejectPendingSubscriptionAcks(error);
      },
      notifyConnected: () => {
        this.onConnectedCallback?.();
        this.onConnected?.();
      },
      notifyDisconnected: () => {
        this.onDisconnectedCallback?.();
        this.onDisconnected?.();
      },
    };
  }

  /**
   * Default `ws`-package WebSocket factory (dynamic import avoids bundling in browsers).
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
