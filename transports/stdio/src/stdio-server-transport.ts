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
 *
 * stdout is the session's channel, so the session ends with the JSONL
 * transport's end report: an end the host did not ask for (an exit, also with
 * code 0, a failed spawn, a failed channel, or stdout ending while the child
 * keeps running) makes the session terminal; `disconnect()` is a requested end
 * and no error.
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
import {
  createJsonlTransport,
  describeTransportEnd,
  mayHaveLeftProcesses,
  notifyObserver,
  type IJsonlTransport,
  type ProcessStopTiming,
  type SubprocessSpawnOptions,
} from '@makaio/subprocess';
import type { PayloadFilter } from '@makaio/core';

/**
 * Options for creating a {@link StdioServerTransport}.
 * @param spawn - Subprocess spawn options for the child extension process.
 * @param name - Optional transport name used as the bus registry key.
 *   Defaults to `'stdio-server'`.
 * @param terminateTree - Whether ending a session also stops every process the
 *   child started (an isolated POSIX process group, or the Windows process
 *   tree) instead of the child alone. Defaults to `true`. The child then runs
 *   in a session of its own: signals aimed at the host's terminal job (Ctrl-C,
 *   a terminal hangup) no longer reach it, and it has no controlling terminal.
 *   A host that dies without ending the session leaves the child running until
 *   it reacts to its stdin closing. Opt out to keep the child in the host's group.
 * @param stopTiming - Bounded phases of ending a session (kill grace, exit
 *   observation, drain); omitted fields take the JSONL transport's defaults.
 *   `disconnect()` takes at most about their sum.
 */
export interface StdioServerTransportOptions {
  readonly spawn: SubprocessSpawnOptions;
  readonly name?: string;
  readonly terminateTree?: boolean;
  readonly stopTiming?: ProcessStopTiming;
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
  private readonly terminateTree: boolean;
  private readonly stopTiming: ProcessStopTiming | undefined;
  private jsonl: IJsonlTransport | null = null;
  /**
   * Stops this transport requested whose session end is not reported yet. A
   * session leaves {@link jsonl} when its stop is requested, but its child and
   * tree run until that end, so every `disconnect()` waits for all of them.
   */
  private readonly pendingStops = new Set<Promise<void>>();
  /**
   * The `connect()` that is waiting for pending stops to end, until it spawns or
   * a `disconnect()` cancels it. Needed because the wait is the only point where
   * a `disconnect()` can arrive while no session exists yet: without it, that
   * `disconnect()` would resolve and the waiting `connect()` would spawn a child
   * afterwards.
   */
  private pendingConnect: symbol | undefined;

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

  /**
   * Set by the transport registry; called once per session that ends without
   * `disconnect()`, after its last message was delivered.
   */
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
    this.terminateTree = options.terminateTree ?? true;
    this.stopTiming = options.stopTiming;
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
   *
   * A new session starts only after the previous one has ended: while a stop
   * requested by `disconnect()` is still pending (its child and tree run until
   * the end is reported), `connect()` waits for it, bounded by the stop timing,
   * and spawns afterwards, so two children are never alive at once. A
   * `disconnect()` that arrives during that wait cancels the `connect()`, which
   * then rejects without spawning.
   * @returns Promise that resolves when the child process is spawned and
   *   initial I/O wiring is in place (not yet ready — await `this.ready`).
   * @throws Error when a session is already open or being opened, or when a
   *   `disconnect()` cancelled this call while it waited for a pending stop.
   */
  public async connect(): Promise<void> {
    if (this.jsonl !== null) {
      throw new Error('StdioServerTransport: already connected');
    }
    if (this.pendingConnect !== undefined) {
      throw new Error('StdioServerTransport: already connecting');
    }
    if (this.pendingStops.size > 0) {
      const attempt = Symbol('connect');
      this.pendingConnect = attempt;
      await Promise.all(this.pendingStops);
      if (this.pendingConnect !== attempt) {
        throw new Error('StdioServerTransport: connect() cancelled by disconnect()');
      }
      this.pendingConnect = undefined;
    }

    if (this.readyResolve === null && this.readyReject === null) {
      this.ready = this.createReadyPromise();
    }
    this.handshakeComplete = false;
    this.terminalError = null;

    // stdout is the session's channel, so its end ends the session. A final
    // line without a newline is parsed at the genuine end of stdout; whatever it
    // holds passes the same shape check as every other line.
    const session = createJsonlTransport({
      ...this.spawnOptions,
      ...this.stopTiming,
      onStdoutEnd: 'terminal',
      finalLine: 'parse',
      terminateTree: this.terminateTree,
    });
    this.jsonl = session;

    session.onMessage((raw) => {
      if (this.jsonl !== session) return;
      this.handleInbound(raw);
    });

    // The end is reported exactly once, after the last stdout message, so a
    // response the child wrote before exiting still settles its correlation
    // before the session terminates. Only `disconnect()` and this handler
    // detach a session before closing it, so an end that still finds its
    // session current is one the host did not ask for.
    void session.ended.then((end) => {
      if (this.jsonl !== session) return;
      const processName = this.spawnOptions.processName ?? this.spawnOptions.command;
      this.terminateSession(new Error(`${processName} ${describeTransportEnd(end)}`));
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
    const jsonl = this.writableSession();
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
   * End the current session on request: stop the child (and its process tree,
   * unless opted out) and release all resources. A requested end is not an
   * error, so `onDisconnected` is not called.
   *
   * A stop is one in-flight operation per session: a `disconnect()` that
   * arrives while an earlier one is still pending, and one that finds no
   * current session, waits for every session whose end has not yet been
   * reported, and so never resolves before the child it stands for is gone.
   * @returns Promise that resolves once the end of every session this transport
   *   stopped was reported; the wait is bounded by the stop timing. An end that
   *   may have left a process behind (an unobserved exit, a held pipe, an
   *   unproven process group) is logged once per session: that process may still
   *   run when the next session starts, which `connect()` does not wait for.
   */
  public async disconnect(): Promise<void> {
    const jsonl = this.jsonl;
    this.jsonl = null;
    this.pendingConnect = undefined;
    this.handshakeComplete = false;
    this.terminalError = null;

    // Resolve the ready promise so any pending awaiters don't hang.
    this.readyResolve?.();
    this.readyResolve = null;
    this.readyReject = null;

    this.correlations.cleanup();

    if (jsonl !== null) this.trackStop(jsonl);
    await Promise.all(this.pendingStops);
  }

  /**
   * Request the end of a session and keep it pending until its end is reported.
   * @param session - Session that was detached from the transport.
   */
  private trackStop(session: IJsonlTransport): void {
    const stop = session.close().then((end) => {
      if (!mayHaveLeftProcesses(end)) return;
      const processName = this.spawnOptions.processName ?? this.spawnOptions.command;
      console.warn(`[${this.name}] ${processName} may have left processes running (${describeTransportEnd(end)})`);
    });
    this.pendingStops.add(stop);
    void stop.finally(() => this.pendingStops.delete(stop));
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
      this.writableSession()?.send({
        type: 'unsubscribe',
        subjects: { [subject]: [] },
      });
    }
  }

  /**
   * Returns `true` when the subscribe-sync handshake has completed and the
   * session still accepts writes. Agrees with `send()`: both stop once the
   * JSONL transport blocks writing, from the observed child exit onwards.
   * @returns `true` if the transport can send messages
   */
  public isReady(): boolean {
    return this.terminalError === null && this.handshakeComplete && this.writableSession() !== null;
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
   * The current session while it still accepts writes. The JSONL transport
   * blocks writing from the observed child exit (or the first channel failure)
   * onwards, while the session stays open until its end is reported: stdout
   * keeps draining for pending requests, but a new write could never be
   * answered. `send()` reports such a session as not connected; subscription
   * changes are buffered for the next session and simply not written.
   * @returns The session while its JSONL transport is writable, otherwise `null`.
   */
  private writableSession(): IJsonlTransport | null {
    return this.jsonl?.status === 'writable' ? this.jsonl : null;
  }

  /**
   * Move the current session into a terminal failed state. Its JSONL transport
   * has already ended and released the child.
   * @param error - Failure that ended the session.
   */
  private terminateSession(error: Error): void {
    this.jsonl = null;
    this.handshakeComplete = false;
    this.terminalError = error;

    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;

    this.correlations.cleanup();

    notifyObserver(this.onDisconnected, (error) => {
      console.error(`[StdioServerTransport] onDisconnected observer threw`, error);
    });
  }

  /**
   * Process a single inbound message from the child's stdout.
   *
   * Pipeline:
   * 1. Validate basic message shape
   * 2. Handle subscribe-sync-complete → resolve ready, send host sync-complete
   * 3. Handle correlation responses (request/broadcast responses)
   * 4. Fan out to application handlers
   *
   * Runs synchronously within the JSONL transport's delivery, so every handler
   * registered when the message arrived has received it before the transport
   * can report its end and the session terminates. Handlers settle on their own;
   * one that rejects or throws affects no other.
   * @param raw - Parsed JSON value from the child's stdout
   */
  private handleInbound(raw: unknown): void {
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
      // The handshake can be the last message a child wrote before it exited;
      // its session then no longer accepts writes and ends on its own.
      this.writableSession()?.send({ type: 'subscribe-sync-complete' });

      this.onConnected?.();
      return;
    }

    if (handleCorrelationResponse(message, this.correlations)) {
      return;
    }

    const context = { transportName: this.name };
    for (const handler of [...this.handlers]) {
      try {
        // Individual handler errors must not crash the inbound pipeline.
        void Promise.resolve(handler(message, context)).catch(() => undefined);
      } catch {
        // A handler that throws synchronously is isolated the same way.
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
    const session = this.writableSession();
    if (session === null) return;

    if (subject !== undefined) {
      session.send({
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

    session.send({
      type: 'subscribe',
      subjects,
      deliveryClasses,
      ...(hasFilters ? { filters } : {}),
    });
  }
}
