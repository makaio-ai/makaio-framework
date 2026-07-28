/**
 * Per-client MCP session ownership for a single HTTP endpoint.
 *
 * ## Why this exists
 *
 * One HTTP endpoint serves many adapter sessions (keyed by the
 * `adapterSessionId` query param) *and* many MCP protocol sessions (keyed by
 * the `Mcp-Session-Id` header). Those are different concepts with different
 * lifetimes. The adapter session is owned by the context registry; the MCP
 * protocol session had no owner, so it defaulted to "the endpoint is the
 * session" — which the SDK enforces as a hard one-client-ever rule, because a
 * streamable-HTTP transport rejects a second `initialize` permanently and a
 * `Server` refuses to connect to a second transport.
 *
 * This registry gives the MCP protocol session an owner: one transport paired
 * with one server per `Mcp-Session-Id`, created on `initialize` and disposed
 * through exactly one sink.
 *
 * ## Lifecycle contract
 *
 * - **Create** — only a `POST` with no `Mcp-Session-Id`. The pair is built,
 *   wired, and connected lazily, then dispatched. It is not in the session map
 *   yet, so it is held in a pending set instead: every pair the registry has
 *   built belongs to exactly one of the two, and shutdown drains both.
 * - **Admit** — the transport's `onsessioninitialized` callback moves the
 *   record from pending into the map. This is the only insertion point, which
 *   is what closes the race where the client's next request lands before the
 *   initialize response has finished writing. A pair that initializes after
 *   the registry closed is not admitted at all.
 * - **Reject-pending** — if the exchange completes while the transport still
 *   has no session ID, the pair never initialized and is disposed.
 * - **Route** — any method carrying a known `Mcp-Session-Id` dispatches to that
 *   transport.
 * - **Liveness** — every dispatched exchange takes an activity lease that is
 *   released when the *response* completes. A client holding its standalone GET
 *   SSE stream therefore never looks idle, which is what keeps long-lived
 *   interactive sessions safe from the reaper.
 * - **Reap** — a periodic sweep closes records with no open exchanges that have
 *   been idle longer than the configured timeout.
 * - **Dispose** — `transport.onclose` deletes the map entry. Map membership is
 *   the idempotency guard, so there is no separate disposed flag. Both a
 *   registry-initiated close and a client `DELETE` converge on that one sink.
 *   The paths that themselves decide to end a session — `closeAll()` and the
 *   sweep — drop the entry before starting teardown, so a session is
 *   unreachable from the moment it is condemned rather than from the moment it
 *   finishes closing. `onclose` then deletes an absent key, which is a no-op.
 * - **Shutdown** — `closeAll()` drains the full ownership chain in lifecycle
 *   order: in-flight startups settle first, then mapped sessions and pending
 *   pairs are torn down, then background disposals the sweep or a lease
 *   release already started are awaited. No phase of a pair's life can
 *   outlive a resolved shutdown. Concurrent callers share one teardown.
 *
 * ## Concurrency
 *
 * `route()` looks a session up and takes its lease in one synchronous step, and
 * the sweep runs as a synchronous timer callback that removes a record before
 * closing it. On a single thread a request therefore either finds a record the
 * sweep has not condemned — and pins it, because a leased record is never
 * reapable — or does not find it at all. No request is ever dispatched into a
 * transport that is already tearing down.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpRouteFailure } from './mcp-http-errors.js';
import { connectMcpServerWithCleanup, settleAllTeardowns } from './mcp-server-lifecycle.js';
import { validateDurationOption, validateTimerDelayOption } from './option-validation.js';

/** Idle time with zero open exchanges before a session is reaped. */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Cadence of the idle-session sweep. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Hooks the registry injects into the transport it asks the caller to build.
 *
 * The caller must forward {@link McpSessionHooks.onSessionInitialized} to the
 * transport's `onsessioninitialized` option — that callback is the registry's
 * only admission point.
 */
export interface McpSessionHooks {
  /**
   * Admit a freshly initialized session under its MCP session ID.
   * @param mcpSessionId - Session ID the transport generated during `initialize`.
   */
  onSessionInitialized(mcpSessionId: string): void;
}

/**
 * Build one unconnected `(transport, server)` pair.
 *
 * The factory must only construct: the registry owns wiring, connecting, and
 * teardown. The transport must expose `sessionId` once initialized.
 */
export type CreateMcpSession<T extends Transport> = (
  hooks: McpSessionHooks,
) => Promise<{ transport: T; server: Server }>;

/** Configuration for {@link McpTransportRegistry}. */
export interface McpTransportRegistryOptions<T extends Transport> {
  /** Builds one unconnected `(transport, server)` pair per MCP client session. */
  createSession: CreateMcpSession<T>;
  /** Idle time with zero open exchanges before a session is closed. Defaults to 10 minutes. */
  idleTimeoutMs?: number;
  /** Sweep cadence for idle sessions. Defaults to 60 seconds. */
  sweepIntervalMs?: number;
}

/** A request reduced to what routing actually depends on. */
export interface McpRouteRequest {
  /** HTTP method of the incoming request. */
  method: string;
  /** Value of the `Mcp-Session-Id` header, when present. */
  mcpSessionId: string | undefined;
}

/** Routing outcome for a session that could not be built or connected. */
export interface McpCreateFailureResult {
  outcome: 'create-failed';
  /** Cause of the failure, already logged by the registry. */
  error: unknown;
}

/** Outcome of routing one request. */
export type McpRouteResult<T extends Transport> =
  | {
      outcome: 'dispatch';
      /** Transport that owns this MCP session. */
      transport: T;
      /** Releases the activity lease; safe to call more than once. */
      finish(): void;
    }
  | { outcome: Exclude<McpRouteFailure, 'create-failed'> }
  | McpCreateFailureResult;

/** One live MCP client session plus its liveness bookkeeping. */
interface McpSessionRecord<T extends Transport> {
  /** Transport bound to this MCP session ID. */
  readonly transport: T;
  /** MCP server instance dedicated to this transport. */
  readonly server: Server;
  /** Timestamp (ms) at which the last exchange started or finished. */
  lastActivity: number;
  /** Number of HTTP exchanges currently holding a lease on this session. */
  openExchanges: number;
}

/**
 * Log a debug-level diagnostic when `MAKAIO_DEBUG` is enabled.
 *
 * `process` is a Node global. The fetch handler mounts this same registry on
 * Cloudflare Workers and Deno, where it is absent unless the host opted into a
 * Node compatibility layer, so reading it unguarded would turn a diagnostic
 * into a `ReferenceError` on the request path.
 * @param message - Human-readable diagnostic message.
 * @param details - Structured routing context.
 */
function debugLog(message: string, details: Record<string, unknown>): void {
  if (typeof process === 'undefined' || process.env?.['MAKAIO_DEBUG'] !== 'true') return;
  console.debug(`[McpTransportRegistry] ${message}`, details);
}

/**
 * Start the idle sweep on a timer that never keeps its host alive by itself.
 *
 * `unref()` exists only on Node's timer object. Web-standard runtimes
 * (Cloudflare Workers, Deno, browsers) return an opaque numeric handle from
 * `setInterval`, so calling it unconditionally would throw while *constructing*
 * the registry — before the endpoint ever serves a request. Feature-detect the
 * capability rather than branching on a runtime name: one handler build ships
 * to all of them, and a runtime that cannot unref simply has no process
 * lifetime for the timer to hold open.
 * @param sweep - Sweep to run on each tick.
 * @param intervalMs - Sweep cadence in milliseconds.
 * @returns The timer handle, already unref'd where the runtime supports it.
 */
function startSweepTimer(sweep: () => void, intervalMs: number): ReturnType<typeof setInterval> {
  const handle: ReturnType<typeof setInterval> = setInterval(sweep, intervalMs);
  if (typeof handle === 'object' && typeof handle.unref === 'function') {
    handle.unref();
  }
  return handle;
}

/**
 * Report a background teardown failure without unhandled-rejection noise.
 * @param error - Rejection raised while closing a session.
 */
function reportDisposalFailure(error: unknown): void {
  console.error('[MCP Server] Failed to close an MCP client session:', error);
}

/**
 * Log a session that could not be built and describe it as a routing outcome.
 *
 * The registry logs this itself so the Node and fetch handlers cannot drift on
 * how a failed session is reported; the cause stays on the outcome for callers
 * that want to inspect it.
 * @param error - Rejection raised while building or connecting the session.
 * @returns The `create-failed` routing outcome carrying the cause.
 */
function reportCreateFailure(error: unknown): McpCreateFailureResult {
  console.error('[MCP Server] Failed to create an MCP client session:', error);
  return { outcome: 'create-failed', error };
}

/**
 * Wrap a response body so the activity lease is released once the body ends.
 *
 * An SSE body stays open for as long as the client holds the stream, which is
 * exactly the liveness signal the reaper relies on: the lease is released on
 * normal end, on cancellation, and on error, and at no other time.
 * @param body - Response body produced by the transport.
 * @param onDone - Lease release callback; invoked at most once by this wrapper.
 * @returns A body stream that mirrors `body` and reports completion.
 */
export function trackStreamCompletion(
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          onDone();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        onDone();
      }
    },
    async cancel(reason) {
      onDone();
      await reader.cancel(reason);
    },
  });
}

/**
 * Registry owning one `(transport, server)` pair per MCP protocol session.
 *
 * Generic over the transport so the Node and fetch handlers share one routing
 * and lifecycle implementation instead of duplicating it per transport family.
 */
export class McpTransportRegistry<T extends Transport> {
  private readonly sessions = new Map<string, McpSessionRecord<T>>();
  private readonly pending = new Set<McpSessionRecord<T>>();

  /**
   * In-flight session constructions.
   *
   * Third link in the ownership chain: a pair belongs to `startups` while it
   * is being built, to `pending` once built but not yet initialized, and to
   * `sessions` after admission. `closeAll()` drains all three in that order,
   * so no phase of a pair's life can outlive a resolved shutdown.
   */
  private readonly startups = new Set<Promise<McpRouteResult<T>>>();

  /** In-flight background disposals started by the sweep or a lease release. */
  private readonly disposals = new Set<Promise<void>>();
  private readonly createSession: CreateMcpSession<T>;
  private readonly idleTimeoutMs: number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private closed = false;

  /** Shared teardown, so every `closeAll()` caller awaits the same shutdown. */
  private closePromise: Promise<void> | undefined;

  /**
   * @param options - Session factory plus idle-reaping configuration.
   * @throws RangeError When `idleTimeoutMs` or `sweepIntervalMs` is not a
   *   positive finite number, or when `sweepIntervalMs` exceeds the runtime's
   *   timer ceiling. Only the sweep interval is bounded by it: the idle timeout
   *   is clock arithmetic, so a multi-week idle policy is legitimate.
   */
  public constructor(options: McpTransportRegistryOptions<T>) {
    this.createSession = options.createSession;
    this.idleTimeoutMs = validateDurationOption(options.idleTimeoutMs, 'idleTimeoutMs') ?? DEFAULT_IDLE_TIMEOUT_MS;
    const sweepIntervalMs =
      validateTimerDelayOption(options.sweepIntervalMs, 'sweepIntervalMs') ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepTimer = startSweepTimer(() => this.sweep(), sweepIntervalMs);
  }

  /**
   * Admitted MCP client sessions.
   * @returns Number of routable sessions currently held by the registry. A pair
   *   whose `initialize` has not completed yet is not one of them.
   */
  public get size(): number {
    return this.sessions.size;
  }

  /**
   * Resolve one request to a transport, or to the reason it cannot be served.
   *
   * Never rejects: a session that fails to build is reported as the
   * `create-failed` outcome so callers have a single error surface.
   * @param request - Method and `Mcp-Session-Id` of the incoming request.
   * @returns The transport to dispatch to plus its lease, or a failure outcome.
   */
  public async route(request: McpRouteRequest): Promise<McpRouteResult<T>> {
    const result = await this.resolve(request);
    debugLog('routed request', {
      method: request.method,
      mcpSessionId: request.mcpSessionId,
      outcome: result.outcome,
      sessions: this.sessions.size,
    });
    return result;
  }

  /**
   * Close every live pair and stop reaping.
   *
   * "Live" means both owner sets: an admitted session and a pair that has been
   * built but has not initialized yet are equally real servers holding equally
   * real bus subscriptions, and shutdown has to wait for both. Draining only
   * the map would leave a pending pair to be disposed by its lease release,
   * which an abandoned response can defer indefinitely.
   *
   * After this resolves the registry refuses all further routing. Concurrent
   * and repeat callers all await the same shared teardown: without that, a
   * second caller would observe the already-cleared owner sets and resolve
   * while the first caller's teardown is still in flight.
   * @returns Promise resolving once every pair has been torn down.
   */
  public closeAll(): Promise<void> {
    return (this.closePromise ??= this.drainAll());
  }

  /**
   * Tear down every owner set in lifecycle order.
   * @returns Promise resolving once every pair has been torn down.
   */
  private async drainAll(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweepTimer);
    // A pair mid-construction is in neither owner set yet. Await every
    // in-flight startup first: whatever it produces lands in `pending`, so
    // the snapshot below tears it down and its close failures aggregate into
    // this shared promise. The startup outcomes are irrelevant here —
    // `route()` reports them to its caller; shutdown only needs them settled.
    // A startup that hangs makes shutdown hang with it, deliberately: a hung
    // transport factory should surface as a hung close, not as a leak behind
    // a shutdown reported clean.
    await Promise.allSettled(this.startups);
    const records = [...this.sessions.values(), ...this.pending];
    this.sessions.clear();
    this.pending.clear();
    // Fourth and last link in the ownership chain: a disposal the sweep or a
    // lease release already started removed its record from the owner sets,
    // but the close itself may still be running. Those in-flight teardowns
    // join the same failure aggregation as the drained records — shutdown
    // must neither resolve mid-teardown nor report clean over a close that
    // failed while it was waiting.
    await settleAllTeardowns(
      [...records.map((record) => record.server.close()), ...this.disposals],
      'Failed to close MCP client sessions',
    );
  }

  /**
   * Dispose a pair in the background, keeping the disposal owned until done.
   *
   * Used by the paths that cannot await a close — the sweep and the lease
   * release — so `drainAll()` can still wait for every in-flight teardown.
   * The raw close promise is what gets tracked: a rejection must stay visible
   * to shutdown's aggregation, so background reporting happens on a separate
   * chain that also keeps the rejection from going unhandled.
   * @param record - Pair whose server is being closed.
   */
  private disposeInBackground(record: McpSessionRecord<T>): void {
    const disposal = record.server.close();
    this.disposals.add(disposal);
    void disposal.catch(reportDisposalFailure).finally(() => this.disposals.delete(disposal));
  }

  /**
   * Apply the routing rules for one request.
   * @param request - Method and `Mcp-Session-Id` of the incoming request.
   * @returns The routing outcome.
   */
  private async resolve(request: McpRouteRequest): Promise<McpRouteResult<T>> {
    if (this.closed) return { outcome: 'closed' };

    if (request.mcpSessionId !== undefined) {
      const record = this.sessions.get(request.mcpSessionId);
      if (!record) return { outcome: 'unknown-session' };
      return this.lease(record);
    }

    // Only a POST can carry an initialize; anything else without a session ID
    // is refused before building a transport. Whether this POST is actually an
    // initialize is the transport's business: a non-initialize body gets the
    // SDK's own "Server not initialized" error and the pair is then disposed.
    if (request.method !== 'POST') return { outcome: 'session-id-required' };

    return this.createPending();
  }

  /**
   * Take an activity lease on a session and hand back its transport.
   * @param record - Session to lease.
   * @returns Dispatch outcome carrying the lease release callback.
   */
  private lease(record: McpSessionRecord<T>): McpRouteResult<T> {
    record.openExchanges += 1;
    record.lastActivity = Date.now();

    let released = false;
    return {
      outcome: 'dispatch',
      transport: record.transport,
      finish: (): void => {
        if (released) return;
        released = true;
        record.openExchanges -= 1;
        record.lastActivity = Date.now();
        // Dispose only what this lease still owns. Ownership is pending-set
        // membership: a successful delete means the pair was never admitted
        // and no drain has claimed it, so this release is the last reference.
        // An admitted pair is owned by the sessions map (sweep, client DELETE,
        // or `closeAll` dispose it), and a drained pair was already torn down
        // by `closeAll` — closing here again would race the first teardown.
        if (this.pending.delete(record)) {
          this.disposeInBackground(record);
        }
      },
    };
  }

  /**
   * Build a new session as a tracked startup task.
   *
   * The construction itself spans two awaits (`createSession`, `connect`)
   * during which the pair exists in neither owner set. Registering the whole
   * task in `startups` closes that window: `closeAll()` awaits these tasks, so
   * a shutdown overlapping a slow factory or connect waits for the pair to be
   * built and self-disposed instead of resolving while its server and bus
   * subscription are still coming up.
   * @returns Dispatch outcome for the new session, or `create-failed`.
   */
  private async createPending(): Promise<McpRouteResult<T>> {
    const startup = this.buildAndLeasePending();
    this.startups.add(startup);
    try {
      return await startup;
    } finally {
      this.startups.delete(startup);
    }
  }

  /**
   * Build, wire, and connect a new session, then lease it for this request.
   * @returns Dispatch outcome for the new session, or `create-failed`.
   */
  private async buildAndLeasePending(): Promise<McpRouteResult<T>> {
    /**
     * Move the pair from pending to admitted under the ID the transport generated.
     *
     * Closes over `record`, which cannot exist until the factory has returned
     * the transport. `onsessioninitialized` only fires from inside
     * `transport.handleRequest`, which callers invoke strictly after `route()`
     * resolves, so `record` is always assigned by then — and the temporal dead
     * zone enforces that ordering without a runtime guard.
     * @param mcpSessionId - Session ID generated during `initialize`.
     */
    const admit = (mcpSessionId: string): void => {
      // Admission is an ownership transfer: only a callback that can still
      // remove the pair from the pending set may publish it. A failed delete
      // means another owner already claimed the pair — `closeAll()` drained
      // it, or the lease release disposed it after the client hung up before
      // this callback fired — and publishing it then would route requests to
      // a transport that is already closed or closing, forever.
      if (!this.pending.delete(record)) return;
      this.sessions.set(mcpSessionId, record);
    };

    let session: { transport: T; server: Server };
    try {
      session = await this.createSession({ onSessionInitialized: admit });
    } catch (error) {
      return reportCreateFailure(error);
    }

    const { transport, server } = session;

    // Wire disposal before connecting so `Protocol.connect` chains this hook
    // ahead of its own, keeping map removal on the single close path shared by
    // client DELETE, idle reaping, and endpoint shutdown.
    transport.onclose = (): void => {
      // `record` is deliberately out of reach here: this hook is wired before
      // the record exists and fires on the connect-failure path, where reading
      // it would throw. Removal from the pending set therefore belongs to the
      // paths that own the record — `admit`, the lease release, `closeAll`.
      const mcpSessionId = transport.sessionId;
      if (mcpSessionId !== undefined) {
        this.sessions.delete(mcpSessionId);
      }
    };

    try {
      await connectMcpServerWithCleanup(server, transport, () => server.close(), 'MCP client session');
    } catch (error) {
      // A connect failure — including one whose cleanup close also failed —
      // is reported on the route path, not the shutdown path, by design. The
      // pair never entered an owner set, so `closeAll()` has nothing of it to
      // drain: the one resource the registry hands the server (its
      // registryChanged bus subscription) is released in the overridden
      // close's `finally` even when close rejects, and the failure itself
      // travels to the caller as this outcome's `cause` regardless of whether
      // a shutdown overlaps the construction.
      return reportCreateFailure(error);
    }

    const record: McpSessionRecord<T> = { transport, server, lastActivity: Date.now(), openExchanges: 0 };
    // Owned from here on: until `admit` publishes it under a session ID, the
    // pending set is the only thing that can reach this pair, and it is what
    // `closeAll()` tears down.
    this.pending.add(record);

    if (this.closed) {
      // `closeAll()` started while this pair was being built. It awaits this
      // startup and only then snapshots the pending set, so ownership passes
      // to the drain's teardown aggregation rather than closing inline here —
      // a close failure then surfaces through `closeAll()`'s shared promise
      // instead of vanishing into a log behind a shutdown reported clean.
      return { outcome: 'closed' };
    }

    return this.lease(record);
  }

  /** Close every session that has been idle with no open exchanges. */
  private sweep(): void {
    const cutoff = Date.now() - this.idleTimeoutMs;
    for (const [mcpSessionId, record] of [...this.sessions]) {
      if (record.openExchanges > 0 || record.lastActivity >= cutoff) continue;
      // Condemn the session synchronously, before teardown starts. Teardown is
      // asynchronous, and `transport.onclose` — the sink that would otherwise
      // remove the entry — only runs once it completes; until then a request
      // carrying this session ID would be dispatched into a transport that is
      // already closing. Deleting first makes the reaped ID answer
      // `unknown-session` immediately, and leaves `onclose` deleting an absent
      // key, which is a no-op.
      this.sessions.delete(mcpSessionId);
      this.disposeInBackground(record);
    }
  }
}
