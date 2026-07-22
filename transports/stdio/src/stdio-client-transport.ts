/**
 * Stdio JSONL client transport for detached extension processes.
 *
 * Reads bus messages from stdin and writes to stdout, enabling a child process
 * to participate as a full bus peer. It does NOT spawn any process — it IS the
 * child process end of the pipe.
 *
 * ## Subscribe-Sync Handshake
 *
 * On `connect()`:
 * 1. Send `{ type: 'subscribe-sync-complete' }` to stdout so the host knows
 *    the child has replayed its local subscriptions.
 * 2. Wait to receive `{ type: 'subscribe-sync-complete' }` from stdin (the host
 *    signals it is done syncing). Resolve the `ready` promise on receipt.
 *
 * Bus dispatch is gated on `ready`; do not route requests through this transport
 * until `ready` resolves.
 */

import type {
  BusBroadcastMessage,
  BusMessage,
  BusReceiveHandler,
  BusRequestMessage,
  BusSubscribeMessage,
  BusTransport,
  BusUnsubscribeMessage,
  SubscriptionDeliveryClass,
} from '@makaio/bus-core';
import {
  CorrelationTracker,
  DEFAULT_REQUEST_TIMEOUT_MS,
  handleCorrelationResponse,
  trackMessageCorrelation,
} from '@makaio/bus-core';
import type { PayloadFilter } from '@makaio/core';
import { decodeBusChunk, encodeBusMessage } from './stdio-framing.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Optional injectable streams for `StdioClientTransport`.
 *
 * Defaults to `process.stdin` / `process.stdout` when not provided.
 * Inject `PassThrough` streams in tests to avoid touching real stdio.
 */
export interface StdioClientTransportOptions {
  /**
   * Readable stream to receive bus messages from.
   * Defaults to `process.stdin`.
   */
  readonly stdin?: NodeJS.ReadableStream;
  /**
   * Writable stream to send bus messages to.
   * Defaults to `process.stdout`.
   */
  readonly stdout?: NodeJS.WritableStream;
  /**
   * Optional transport name override.
   * Defaults to `'stdio-client'`.
   */
  readonly name?: string;
  /**
   * Optional malformed-input/error observer.
   */
  readonly onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Child-side stdio bus transport.
 *
 * Wraps a pair of Node.js streams (defaulting to `process.stdin` /
 * `process.stdout`) as a `BusTransport`. Suitable for detached extension
 * processes that communicate with a host over stdio JSONL.
 * @example
 * ```typescript
 * const transport = new StdioClientTransport();
 * await transport.connect();
 * await transport.ready; // wait for host subscribe-sync-complete
 * ```
 */
export class StdioClientTransport implements BusTransport {
  /** Transport identity for the bus registry. */
  public readonly name: string;

  private readonly stdin: NodeJS.ReadableStream;
  private readonly stdout: NodeJS.WritableStream;

  private readonly correlations = new CorrelationTracker();
  private readonly handlers = new Set<BusReceiveHandler>();
  private readonly errorHandlers = new Set<(error: Error) => void>();

  private connected = false;
  private handshakeComplete = false;
  private lineBuffer = '';
  private dataListener: ((chunk: string) => void) | null = null;
  private endListener: (() => void) | null = null;

  /** Resolver for the `ready` promise; `null` once resolved. */
  private readyResolve: (() => void) | null = null;

  /** Rejecter for the `ready` promise; `null` once settled. */
  private readyReject: ((error: Error) => void) | null = null;

  /**
   * Resolves when the subscribe-sync-complete handshake has completed
   * (i.e., both sides have finished advertising their subscriptions).
   * Bus dispatch is gated on this promise.
   */
  public ready: Promise<void>;

  /** Set by the transport registry to track each session's ready promise. */
  public onNewReadySession: ((promise: Promise<void>) => void) | undefined = undefined;

  /** Set by the transport registry; called after connect + subscription sync. */
  public onConnected: (() => void) | undefined = undefined;

  /** Set by the transport registry; called when the connection drops unexpectedly. */
  public onDisconnected: (() => void) | undefined = undefined;

  /**
   * Create a `StdioClientTransport`.
   * @param options - Optional injectable streams, transport name, and error handler
   */
  public constructor(options: StdioClientTransportOptions = {}) {
    this.name = options.name ?? 'stdio-client';
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    if (options.onError) {
      this.errorHandlers.add(options.onError);
    }

    this.ready = this.createReadyPromise();
  }

  /**
   * Connect the transport.
   *
   * Resumes stdin, sets utf-8 encoding, begins JSONL line parsing, and sends
   * the `subscribe-sync-complete` handshake to the host. The `ready` promise
   * resolves when the host's `subscribe-sync-complete` arrives.
   * @throws Error if already connected
   */
  public async connect(): Promise<void> {
    if (this.connected) {
      throw new Error('StdioClientTransport: already connected');
    }

    if (this.readyResolve === null && this.readyReject === null) {
      this.ready = this.createReadyPromise();
    }
    this.connected = true;
    this.handshakeComplete = false;
    this.lineBuffer = '';

    // Configure stdin and attach listeners before resume() so synchronous
    // streams cannot emit handshake data before the parser is installed.
    if (typeof (this.stdin as NodeJS.Socket).setEncoding === 'function') {
      (this.stdin as NodeJS.Socket).setEncoding('utf8');
    }
    const dataListener = (chunk: string): void => {
      this.handleChunk(chunk);
    };
    this.dataListener = dataListener;

    const endListener = (): void => {
      this.handleDisconnect();
    };
    this.endListener = endListener;

    this.stdin.on('data', dataListener);
    this.stdin.on('end', endListener);
    this.stdin.resume();

    // Signal to the host that this side has completed subscription sync.
    this.writeMessage({ type: 'subscribe-sync-complete' });
  }

  /**
   * Disconnect the transport.
   *
   * Pauses stdin and removes listeners. Does NOT call `process.exit()`.
   */
  public async disconnect(): Promise<void> {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    const completedHandshake = this.handshakeComplete;
    this.handshakeComplete = false;
    this.removeListeners();
    this.stdin.pause();

    this.settleReadyAfterDisconnect(completedHandshake);

    this.correlations.cleanup();
  }

  /**
   * Send a message over stdout as a JSONL line.
   * @param message - Bus message to send
   * @param timeout - Correlation timeout in milliseconds; `0` means no automatic timeout
   * @returns Promise resolving to response (requests), results (broadcasts), or boolean (other)
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
    if (!this.connected) {
      throw new Error('StdioClientTransport: not connected');
    }

    this.writeMessage(message);

    return trackMessageCorrelation(message, this.correlations, timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  /**
   * Register a handler for inbound bus messages.
   * @param handler - Invoked for each decoded inbound message
   * @returns Unsubscribe function
   */
  public onReceive(handler: BusReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Register a handler for malformed input and stream-level transport errors.
   * @param handler - Invoked when the transport detects an input error.
   * @returns Unsubscribe function
   */
  public onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to a subject by sending a `subscribe` message to the host.
   *
   * The host uses this information to route messages to this child process.
   * @param subject - Subject pattern (supports wildcards like `'adapter.*'`)
   * @param filter - Optional payload filter for server-side smart-routing
   * @param priorities - Handler priorities registered for this subject
   * @param deliveryClass - Whether the subscription may be advertised beyond its direct peer
   */
  public async subscribe(
    subject: string,
    filter?: PayloadFilter,
    priorities: number[] = [],
    deliveryClass: SubscriptionDeliveryClass = 'relayable',
  ): Promise<void> {
    const message: BusSubscribeMessage = {
      type: 'subscribe',
      subjects: { [subject]: priorities },
      deliveryClasses: { [subject]: deliveryClass },
      ...(filter !== undefined ? { filters: { [subject]: filter } } : {}),
    };
    this.writeMessage(message);
  }

  /**
   * Unsubscribe from a subject by sending an `unsubscribe` message to the host.
   * @param subject - Subject pattern to unsubscribe from
   */
  public async unsubscribe(subject: string): Promise<void> {
    const message: BusUnsubscribeMessage = {
      type: 'unsubscribe',
      subjects: { [subject]: [] },
    };
    this.writeMessage(message);
  }

  /**
   * Returns `true` when the transport is connected and the subscribe-sync
   * handshake has completed.
   * @returns `true` if the transport can send messages
   */
  public isReady(): boolean {
    return this.connected && this.handshakeComplete;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Write a message object to stdout as a JSONL line.
   * @param message - Object to encode and write
   */
  private writeMessage(message: object): void {
    this.stdout.write(encodeBusMessage(message));
  }

  /**
   * Create a fresh ready promise and notify the registry for reconnects.
   * @returns Ready promise for the current session.
   */
  private createReadyPromise(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Mark internal handshake failures as observed even when callers choose
    // not to await `ready`; awaiting the original promise still rejects.
    promise.catch(() => undefined);
    this.onNewReadySession?.(promise);
    return promise;
  }

  /**
   * Process an incoming data chunk, parsing complete JSONL lines.
   * @param chunk - New data chunk from stdin
   */
  private handleChunk(chunk: string): void {
    const { messages, remaining, errors } = decodeBusChunk(chunk, this.lineBuffer);
    this.lineBuffer = remaining;

    for (const line of errors) {
      this.reportError(new Error(`Failed to parse stdio JSONL: ${line}`));
    }

    for (const parsed of messages) {
      this.dispatchMessage(parsed);
    }
  }

  /**
   * Dispatch a single parsed message to the appropriate handler.
   *
   * Routes `subscribe-sync-complete` to the ready resolver, correlation
   * responses to the tracker, and all other messages to registered handlers.
   * @param parsed - Parsed message object from the wire
   */
  private dispatchMessage(parsed: unknown): void {
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).type !== 'string') {
      this.reportError(new Error('Received malformed stdio bus message'));
      return;
    }

    const message = parsed as BusMessage;

    // Resolve the ready promise when the host signals sync-complete.
    if (message.type === 'subscribe-sync-complete') {
      if (!this.handshakeComplete) {
        this.handshakeComplete = true;
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        this.onConnected?.();
      }
      return;
    }

    // Filter heartbeats — no need to forward to application handlers.
    if (message.type === 'heartbeat') {
      return;
    }

    // Resolve pending request/broadcast correlations.
    if (handleCorrelationResponse(message, this.correlations)) {
      return;
    }

    // Fan out to application handlers.
    for (const handler of this.handlers) {
      try {
        void Promise.resolve(handler(message, { transportName: this.name })).catch(() => undefined);
      } catch {
        // Individual handler errors must not crash the inbound pipeline.
      }
    }
  }

  /**
   * Handle stdin end (host closed the pipe).
   *
   * Cleans up state and notifies the registry of an unexpected disconnection.
   */
  private handleDisconnect(): void {
    if (!this.connected) {
      return;
    }

    this.connected = false;
    const completedHandshake = this.handshakeComplete;
    this.handshakeComplete = false;
    this.removeListeners();

    this.settleReadyAfterDisconnect(completedHandshake);

    this.correlations.cleanup();
    this.onDisconnected?.();
  }

  /**
   * Notify registered error observers.
   * @param error - Error detected by the transport.
   */
  private reportError(error: Error): void {
    for (const handler of this.errorHandlers) {
      try {
        handler(error);
      } catch {
        // Error observers must not crash transport internals.
      }
    }
  }

  /**
   * Settle the ready promise when the stdio session closes.
   * @param completedHandshake - Whether the session reached subscribe-sync completion.
   */
  private settleReadyAfterDisconnect(completedHandshake: boolean): void {
    if (completedHandshake) {
      this.readyResolve?.();
    } else {
      this.readyReject?.(new Error('StdioClientTransport: disconnected before subscribe-sync-complete'));
    }
    this.readyResolve = null;
    this.readyReject = null;
  }

  /**
   * Remove stdin data and end listeners, clearing stored references.
   */
  private removeListeners(): void {
    if (this.dataListener !== null) {
      this.stdin.off('data', this.dataListener);
      this.dataListener = null;
    }
    if (this.endListener !== null) {
      this.stdin.off('end', this.endListener);
      this.endListener = null;
    }
  }
}
