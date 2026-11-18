/**
 * Host-side stdio transport for spawned extension processes.
 *
 * Implements the {@link BusTransport} interface over stdin/stdout using JSONL
 * framing. The host spawns a child extension process via
 * {@link createJsonlTransport} and exchanges bus messages line-by-line.
 *
 * The subscribe-sync handshake mirrors the WebSocket client protocol:
 * 1. Host calls `connect()` — spawns the child and wires message handling.
 * 2. Child sends `subscribe-sync-complete` once it has advertised its subjects.
 * 3. Host resolves its `ready` promise on receipt of the child's sync-complete.
 * 4. Host sends its own `subscribe-sync-complete` after replaying its
 *    subscriptions so the child knows the host is ready too.
 */

import {
  CorrelationTracker,
  DEFAULT_REQUEST_TIMEOUT_MS,
  handleCorrelationResponse,
  trackMessageCorrelation,
  type BusBroadcastMessage,
  type BusMessage,
  type BusReceiveHandler,
  type BusRequestMessage,
  type BusTransport,
  type SubscriptionDeliveryClass,
} from '@makaio/bus-core';
import { createJsonlTransport, type IJsonlTransport, type SubprocessSpawnOptions } from '@makaio/subprocess';
import type { PayloadFilter } from '@makaio/core';

/**
 * Options for creating a {@link StdioServerTransport}.
 * @param spawn - Subprocess spawn options for the child extension process.
 * @param name - Optional transport name used as the bus registry key.
 *   Defaults to `'stdio-server'`.
 */
export interface StdioServerTransportOptions {
  readonly spawn: SubprocessSpawnOptions;
  readonly name?: string;
}

/**
 * Host-side stdio transport that communicates with a spawned child process
 * via JSONL-framed bus messages on stdin/stdout.
 *
 * The `ready` promise resolves once the subscribe-sync handshake completes —
 * i.e. when the child sends `{ type: 'subscribe-sync-complete' }`.
 * @example
 * ```typescript
 * const transport = new StdioServerTransport({
 *   spawn: { command: 'node', args: ['extension.js'], cwd: '/path/to/ext' },
 * });
 * await transport.connect();
 * await transport.ready;
 * ```
 */
export class StdioServerTransport implements BusTransport {
  /** Unique transport name used as the bus registry key. */
  public readonly name: string;

  private readonly spawnOptions: SubprocessSpawnOptions;
  private jsonl: IJsonlTransport | null = null;

  private readonly handlers = new Set<BusReceiveHandler>();
  private readonly correlations = new CorrelationTracker();
  private handshakeComplete = false;
  private terminalError: Error | null = null;

  /**
   * Subjects the host has subscribed to, plus their priorities and optional
   * payload filters. Stored for replay after reconnect and for building the
   * outbound subscribe wire message.
   */
  private readonly localSubscriptions = new Map<
    string,
    { priorities: number[]; filter?: PayloadFilter; deliveryClass: SubscriptionDeliveryClass }
  >();

  /** Resolver for the current `ready` promise; `null` once resolved. */
  private readyResolve: (() => void) | null = null;

  /** Rejecter for the current `ready` promise; `null` once settled. */
  private readyReject: ((error: Error) => void) | null = null;

  /** Set by the transport registry; tracks each session's ready promise. */
  public onNewReadySession: ((promise: Promise<void>) => void) | undefined = undefined;

  /** Set by the transport registry; called after subscribe-sync completes. */
  public onConnected: (() => void) | undefined = undefined;

  /** Set by the transport registry; called when the process exits unexpectedly. */
  public onDisconnected: (() => void) | undefined = undefined;

  /**
   * Resolves when the subscribe-sync handshake completes for the current
   * session.
   */
  public ready: Promise<void>;

  /**
   * Create a new `StdioServerTransport`.
   * @param options - Transport configuration including subprocess spawn options.
   */
  public constructor(options: StdioServerTransportOptions) {
    this.name = options.name ?? 'stdio-server';
    this.spawnOptions = options.spawn;
    this.ready = this.createReadyPromise();
  }

  /**
   * Spawn the child process, wire message handling, and complete the
   * subscribe-sync handshake.
   *
   * Sends the host's current subscriptions to the child, then waits for the
   * child to send `subscribe-sync-complete` before resolving. After the child
   * confirms, the host sends its own `subscribe-sync-complete` so the child
   * knows the host is ready.
   * @returns Promise that resolves when the child process is spawned and
   *   initial I/O wiring is in place (not yet ready — await `this.ready`).
   */
  public async connect(): Promise<void> {
    if (this.jsonl !== null) {
      throw new Error('StdioServerTransport: already connected');
    }

    if (this.readyResolve === null && this.readyReject === null) {
      this.ready = this.createReadyPromise();
    }
    this.handshakeComplete = false;
    this.terminalError = null;

    const session = createJsonlTransport(this.spawnOptions);
    this.jsonl = session;

    session.onMessage((raw) => {
      if (this.jsonl !== session) return;
      void this.handleInbound(raw);
    });

    // The JSONL transport reports every end of the child exactly once, and only
    // after the last stdout message, so a response the child wrote before
    // exiting still settles its correlation before the session terminates.
    // TODO(FACT-459): bound the stdout drain after exit (I2/O3 drain deadline); a descendant holding stdout keeps the session open until close.
    session.onError((error) => {
      if (this.jsonl !== session) return;
      this.terminateSession(error);
    });

    // Replay any pre-connect subscriptions to the child process.
    if (this.localSubscriptions.size > 0) {
      this.sendSubscribeMessage();
    }
  }

  /**
   * Send a bus message to the child process.
   * @param message - Bus message to send
   * @param timeout - Correlation timeout for requests; `0` means no timeout
   * @returns Promise resolving to response (requests), results (broadcasts),
   *   or `true` (all other message types)
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
    const jsonl = this.writableJsonl();
    if (jsonl === null) {
      throw new Error('StdioServerTransport: not connected');
    }

    jsonl.send(message);

    return trackMessageCorrelation(message, this.correlations, timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);
  }

  /**
   * Register a handler for incoming messages from the child process.
   * @param handler - Invoked for each decoded inbound bus message
   * @returns Unsubscribe function
   */
  public onReceive(handler: BusReceiveHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Kill the child process and release all resources.
   * @returns Promise that resolves when the transport is disconnected
   */
  public async disconnect(): Promise<void> {
    const jsonl = this.jsonl;
    this.jsonl = null;
    this.handshakeComplete = false;
    this.terminalError = null;

    // Resolve the ready promise so any pending awaiters don't hang.
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;

    this.correlations.cleanup();

    jsonl?.close();
  }

  /**
   * Subscribe to a subject on the child process.
   *
   * Buffers the subscription so it can be replayed if the transport reconnects.
   * Sends immediately when the process is running.
   * @param subject - Subject pattern to subscribe to
   * @param filter - Optional payload filter for smart routing
   * @param priorities - Handler priorities registered for this subject
   * @param deliveryClass - Whether the subscription may be advertised beyond its direct peer
   * @returns Promise that resolves when the subscription is buffered (and sent)
   */
  public async subscribe(
    subject: string,
    filter?: PayloadFilter,
    priorities: number[] = [],
    deliveryClass?: SubscriptionDeliveryClass,
  ): Promise<void> {
    const resolvedDeliveryClass = deliveryClass ?? this.localSubscriptions.get(subject)?.deliveryClass ?? 'relayable';
    this.localSubscriptions.set(subject, { priorities, filter, deliveryClass: resolvedDeliveryClass });

    this.sendSubscribeMessage(subject, filter, priorities, resolvedDeliveryClass);
  }

  /**
   * Unsubscribe from a subject on the child process.
   *
   * Removes the subject from the local buffer and sends an unsubscribe message
   * when the process is running.
   * @param subject - Subject to unsubscribe from
   * @returns Promise that resolves when the removal is complete
   */
  public async unsubscribe(subject: string): Promise<void> {
    const wasSubscribed = this.localSubscriptions.delete(subject);

    if (wasSubscribed) {
      this.writableJsonl()?.send({
        type: 'unsubscribe',
        subjects: { [subject]: [] },
      });
    }
  }

  /**
   * Returns `true` when the subscribe-sync handshake has completed and the
   * child can still receive writes. Agrees with `send()`: both stop at the
   * observed child exit (code or signal), before the session is terminated.
   * @returns `true` if the transport can send messages
   */
  public isReady(): boolean {
    return this.terminalError === null && this.handshakeComplete && this.writableJsonl() !== null;
  }

  /**
   * Cancel a pending correlated request.
   * @param correlationId - Correlation ID to cancel
   * @param error - Optional cancellation error
   */
  public cancelRequest(correlationId: string, error?: Error): void {
    this.correlations.cancel(correlationId, error);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Create a fresh ready promise and store the resolve/reject callbacks.
   * @returns New ready promise for the current session.
   */
  private createReadyPromise(): Promise<void> {
    const promise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.onNewReadySession?.(promise);
    return promise;
  }

  /**
   * Return the current JSONL session only while the child can still receive
   * writes.
   *
   * Writing is blocked from the observed child exit onwards, although the
   * session itself stays open until stdout closes: a descendant holding stdout
   * delays `close` well past `exit`, and a write to the destroyed stdin would
   * fail silently while its correlation kept waiting for a reply that can
   * never come. Stdout keeps draining for requests that are already pending.
   * @returns The session while the child's stdin is writable, otherwise `null`.
   */
  private writableJsonl(): IJsonlTransport | null {
    const jsonl = this.jsonl;
    return jsonl !== null && jsonl.process.stdin?.writable === true ? jsonl : null;
  }

  /**
   * Move the current session into a terminal failed state and release its
   * JSONL transport.
   * @param error - Failure that ended the session.
   */
  private terminateSession(error: Error): void {
    const jsonl = this.jsonl;
    this.jsonl = null;
    this.handshakeComplete = false;
    this.terminalError = error;

    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;

    this.correlations.cleanup();

    jsonl?.close();

    this.onDisconnected?.();
  }

  /**
   * Process a single inbound message from the child's stdout.
   *
   * Pipeline:
   * 1. Validate basic message shape
   * 2. Handle subscribe-sync-complete → resolve ready, send host sync-complete
   * 3. Handle correlation responses (request/broadcast responses)
   * 4. Fan out to application handlers
   * @param raw - Parsed JSON value from the child's stdout
   */
  private async handleInbound(raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== 'object' || typeof (raw as Record<string, unknown>).type !== 'string') {
      return;
    }

    const message = raw as BusMessage;

    if (message.type === 'heartbeat') {
      return;
    }

    // Child signals that its subscriptions are fully advertised.
    if (message.type === 'subscribe-sync-complete') {
      this.handshakeComplete = true;
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;

      // Send our own sync-complete so the child knows the host is ready too.
      this.writableJsonl()?.send({ type: 'subscribe-sync-complete' });

      this.onConnected?.();
      return;
    }

    if (handleCorrelationResponse(message, this.correlations)) {
      return;
    }

    for (const handler of this.handlers) {
      try {
        await handler(message, { transportName: this.name });
      } catch {
        // Individual handler errors must not crash the inbound pipeline.
      }
    }
  }

  /**
   * Build and send a subscribe wire message for the given subject, or for all
   * local subscriptions when no subject is provided.
   * @param subject - Specific subject to subscribe; omit to send all.
   * @param filter - Payload filter for the subject.
   * @param priorities - Handler priorities for the subject.
   * @param deliveryClass - Whether the subscription may be advertised beyond its direct peer.
   */
  private sendSubscribeMessage(
    subject?: string,
    filter?: PayloadFilter,
    priorities: number[] = [],
    deliveryClass: SubscriptionDeliveryClass = 'relayable',
  ): void {
    const jsonl = this.writableJsonl();
    if (jsonl === null) return;

    if (subject !== undefined) {
      jsonl.send({
        type: 'subscribe',
        subjects: { [subject]: priorities },
        deliveryClasses: { [subject]: deliveryClass },
        ...(filter !== undefined ? { filters: { [subject]: filter } } : {}),
      });
      return;
    }

    // Replay all subscriptions.
    const subjects: Record<string, number[]> = {};
    const deliveryClasses: Record<string, SubscriptionDeliveryClass> = {};
    const filters: Record<string, PayloadFilter> = {};
    let hasFilters = false;

    for (const [subj, entry] of this.localSubscriptions) {
      subjects[subj] = entry.priorities;
      deliveryClasses[subj] = entry.deliveryClass;
      if (entry.filter !== undefined) {
        filters[subj] = entry.filter;
        hasFilters = true;
      }
    }

    jsonl.send({
      type: 'subscribe',
      subjects,
      deliveryClasses,
      ...(hasFilters ? { filters } : {}),
    });
  }
}
