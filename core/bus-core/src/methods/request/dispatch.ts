import type { MakaioBusContext, WithReceiveContext } from '../../types/index.js';
import type { HandlerEntry } from '../../types/handler-entry.js';
import type { RequestContext, SubjectDefinition, RequestHandler } from '@makaio/core';
import { getMatchingHandlerEntries, getMatchingRemoteEntries } from './getMatchingHandlers.js';
import { getFullSubjectForSubjectDefinition } from '../../utils/subject-transformation.js';
import { isNoHandlerErrorForSubject } from '../../utils/transport.js';
import { RequestError } from '../../errors/index.js';
import { awaitWithTimeoutAndSignal, toAbortError } from './await-with-timeout-and-signal.js';

/** Options for the recursive dispatch function. */
export interface DispatchOptions extends WithReceiveContext {
  /** Explicit transport allowlist for remote dispatch. */
  allowedTransports?: ReadonlyArray<string>;
  /**
   * Priority cursor from an originating transport hop.
   *
   * When set, entries with priority at or above this value are skipped so that the
   * remote chain continues from exactly where the sender left off. Leave `undefined`
   * for the first local dispatch — execution starts from the highest-priority handler.
   *
   * This field is only used on initial entry (when converting a transport message into
   * a dispatch call). Within a single node, `next()` advances by array index rather
   * than by priority, so equal-priority handlers always run in registration order.
   */
  priority?: number;
  /** Correlation ID for tracking. */
  correlationId: string;
  /** Message identifier. */
  messageId: string;
  /** Timeout in milliseconds. `0` means no automatic timeout. */
  timeout: number;
  /**
   * Absolute dispatch deadline as a Unix timestamp in milliseconds.
   * Set on first dispatch, propagated through all subsequent hops so each hop
   * can compute its remaining time budget without relying on the original timeout value.
   */
  deadline?: number;
  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;
  /**
   * When `true`, remote entries are skipped even if the subject is not marked local.
   * Used when the caller explicitly opts into local-only dispatch (e.g., `transports: []`).
   */
  localOnly?: boolean;
}

/** Outcome of a dispatch attempt. */
export interface DispatchOutcome {
  /** Whether any handler produced a result. */
  handled: boolean;
  /** The result value if handled. Always present when `handled` is `true`. */
  value?: unknown;
}

/** A merged entry for a local handler. */
type LocalEntry = HandlerEntry<RequestHandler<unknown, unknown>> & { kind: 'local' };

/** A merged entry for a remote transport pointer. */
type RemoteEntry = { transport: string; priority: number; kind: 'remote' };

/** Union of local and remote entries used in the merged dispatch list. */
type MergedEntry = LocalEntry | RemoteEntry;

/**
 * Build a merged, priority-sorted list of local handler entries and remote transport
 * entries.
 *
 * Sorted by priority descending. Local entries win ties over remote entries so that
 * equal-priority local handlers run before remote hops, avoiding unnecessary network
 * round-trips. Relative order within local entries and within remote entries at the
 * same priority is preserved (stable sort).
 * @param localEntries - Local handler entries, already sorted by priority descending
 * @param remoteEntries - Remote transport entries
 * @returns Merged array ordered by priority descending (local beats remote on ties)
 */
function buildMergedList(
  localEntries: ReadonlyArray<HandlerEntry<RequestHandler<unknown, unknown>>>,
  remoteEntries: ReadonlyArray<{ transport: string; priority: number }>,
): MergedEntry[] {
  const merged: MergedEntry[] = [
    ...localEntries.map((e): LocalEntry => ({ ...e, kind: 'local' })),
    ...remoteEntries.map((e): RemoteEntry => ({ ...e, kind: 'remote' })),
  ];

  // Stable sort: descending priority, local entries precede remote entries on ties.
  merged.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    if (a.kind === 'local' && b.kind === 'remote') return -1;
    if (a.kind === 'remote' && b.kind === 'local') return 1;
    return 0;
  });

  return merged;
}

/**
 * Apply an explicit transport allowlist to remote entries.
 *
 * When the allowlist is present but no advertised handlers have arrived yet,
 * synthesize one remote entry per allowed transport so dispatch can still route
 * to the requested peer. This closes the subscribe-propagation race for callers
 * that explicitly constrain transport routing.
 * @param context - Bus context used to resolve current transport registrations
 * @param remoteEntries - Advertised remote entries for the subject
 * @param allowedTransports - Optional explicit transport allowlist
 * @returns Filtered or synthesized remote entries
 */
function resolveRemoteEntries(
  context: MakaioBusContext,
  remoteEntries: ReadonlyArray<{ transport: string; priority: number }>,
  allowedTransports?: ReadonlyArray<string>,
): Array<{ transport: string; priority: number }> {
  if (!allowedTransports || allowedTransports.length === 0) {
    return [...remoteEntries];
  }

  const allowed = new Set(allowedTransports);
  const filtered = remoteEntries.filter((entry) => allowed.has(entry.transport));
  if (filtered.length > 0) {
    return filtered;
  }

  const unique = [...new Set(allowedTransports)];
  return unique
    .filter((transportName) => {
      const transport = context.transportRegistry.getTransport(transportName);
      if (!transport) return false;
      return transport.isReady?.() !== false;
    })
    .map((transport) => ({ transport, priority: 0 }));
}

/**
 * Execute one step in the merged dispatch chain.
 *
 * Picks the entry at `index`, executes it, and returns the outcome. When the list
 * is exhausted, rethrows `firstTransportError` if one was collected during remote
 * dispatch (preserving the old "return first non-NoHandler error" contract), or
 * returns `{ handled: false }` otherwise.
 * @param context - Bus context
 * @param subjectDefinition - Subject definition
 * @param payload - Current payload
 * @param merged - Pre-built merged list of local + remote entries
 * @param index - Current position in `merged`
 * @param options - Dispatch options
 * @param firstTransportError - First non-NoHandler transport error collected so far
 * @returns Dispatch outcome
 */
async function stepDispatch(
  context: MakaioBusContext,
  subjectDefinition: SubjectDefinition,
  payload: unknown,
  merged: MergedEntry[],
  index: number,
  options: DispatchOptions,
  firstTransportError?: unknown,
): Promise<DispatchOutcome> {
  if (index >= merged.length) {
    // Chain exhausted — rethrow the first transport error if any transport failed.
    if (firstTransportError !== undefined) {
      throw firstTransportError;
    }
    return { handled: false };
  }

  const entry = merged[index];

  if (entry.kind === 'local') {
    return executeLocalEntry(
      context,
      subjectDefinition,
      payload,
      entry,
      merged,
      index + 1,
      options,
      firstTransportError,
    );
  }

  return executeRemoteEntry(
    context,
    subjectDefinition,
    payload,
    entry,
    merged,
    index + 1,
    options,
    firstTransportError,
  );
}

/**
 * Execute a single local handler.
 *
 * Creates a `RequestContext` where `ctx.next()` calls `stepDispatch()` at
 * `nextIndex`. Auto-advances (without requiring an explicit `next()` call) if the
 * handler calls neither `setResult()` nor `next()`.
 * @param context - Bus context
 * @param subjectDefinition - Subject definition
 * @param payload - Current request payload
 * @param entry - Local handler entry
 * @param merged - Full merged list
 * @param nextIndex - Index for the next step after this handler
 * @param options - Dispatch options
 * @param firstTransportError - First non-NoHandler transport error collected so far;
 *   threaded through so it survives local fallthrough after a remote failure
 * @returns Dispatch outcome
 */
// eslint-disable-next-line max-lines-per-function -- context object construction is inherently verbose; splitting would fragment related state
async function executeLocalEntry(
  context: MakaioBusContext,
  subjectDefinition: SubjectDefinition,
  payload: unknown,
  entry: LocalEntry,
  merged: MergedEntry[],
  nextIndex: number,
  options: DispatchOptions,
  firstTransportError?: unknown,
): Promise<DispatchOutcome> {
  const subjectKey = subjectDefinition.subject;
  let resultValue: unknown;
  let hasResult = false;
  let nextPromise: Promise<void> | undefined;
  let currentPayload = payload;

  const ctx: RequestContext<unknown, unknown> = {
    isRequest: true,
    get payload() {
      return currentPayload;
    },
    get result() {
      return hasResult ? resultValue : undefined;
    },
    messageId: options.messageId,
    correlationId: options.correlationId,
    transport: options.transport,
    ...(options.signal !== undefined && { signal: options.signal }),
    setResult: (value) => {
      resultValue = value;
      hasResult = true;
    },
    extendResult: (extension) => {
      resultValue = {
        ...(hasResult ? (resultValue as Record<string, unknown>) : {}),
        ...(extension as Record<string, unknown>),
      };
      hasResult = true;
    },
    replacePayload: (newPayload) => {
      currentPayload = newPayload;
    },
    next: () => {
      // Each call starts a new downstream dispatch, but only the first promise
      // is tracked and awaited after the handler returns. Callers should invoke
      // next() at most once; additional calls are fire-and-forget.
      const promise = (async () => {
        const outcome = await stepDispatch(
          context,
          subjectDefinition,
          currentPayload,
          merged,
          nextIndex,
          options,
          firstTransportError,
        );
        if (outcome.handled && !hasResult) {
          resultValue = outcome.value;
          hasResult = true;
        }
      })();
      nextPromise = nextPromise ?? promise;
      return promise;
    },
  };

  try {
    await entry.handler(ctx);

    // If next() was called (with or without await), settle the outstanding
    // downstream work now. For properly-awaited handlers this is a no-op;
    // for fire-and-forget callers it captures the result and surfaces errors.
    if (nextPromise !== undefined) {
      await nextPromise;
    } else if (!hasResult) {
      // Auto-advance: handler called neither setResult() nor next().
      const outcome = await stepDispatch(
        context,
        subjectDefinition,
        currentPayload,
        merged,
        nextIndex,
        options,
        firstTransportError,
      );
      if (outcome.handled) {
        resultValue = outcome.value;
        hasResult = true;
      }
    }
  } catch (error) {
    if (error instanceof RequestError) {
      throw error; // Already wrapped — don't double-wrap.
    }
    throw new RequestError(
      subjectKey,
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error : undefined,
    );
  }

  return { handled: hasResult, value: resultValue };
}

// Design note: a single priority cursor means the remote node runs ALL its
// handlers below the cursor before returning. This gives coarse-grained
// priority ordering across transports (e.g., priority 400 always before 200)
// but does NOT interleave individual entries across transport boundaries
// (e.g., localA:250 does not run between remoteB:300 and remoteB:200).
// True per-entry interleaving would require a round-trip per handler, which
// is impractical for network latency. The priority cursor is a deliberate
// trade-off: correct priority ordering at the tier level, batched execution
// within each remote hop.
/**
 * Forward the request to a remote transport.
 *
 * Sends a `BusRequestMessage` with `priority` set to the entry's priority value
 * so the remote node starts dispatch from handlers strictly below that threshold.
 *
 * Error handling:
 * - **NoHandlerError** — remote chain exhausted; continue at `nextIndex`.
 * - **Other transport errors** — logged and skipped; continue at `nextIndex` so
 *   a transient transport failure (e.g. "session not established") does not block
 *   other handlers. The first such error is captured and rethrown only if the
 *   entire chain produces no result.
 * @param context - Bus context
 * @param subjectDefinition - Subject definition
 * @param payload - Current request payload
 * @param entry - Remote transport entry
 * @param merged - Full merged list (used for fallback after remote defers)
 * @param nextIndex - Index to use if the remote chain is exhausted
 * @param options - Dispatch options
 * @param firstTransportError - First non-NoHandler error encountered so far (for rethrow)
 * @returns Dispatch outcome
 */
async function executeRemoteEntry(
  context: MakaioBusContext,
  subjectDefinition: SubjectDefinition,
  payload: unknown,
  entry: RemoteEntry,
  merged: MergedEntry[],
  nextIndex: number,
  options: DispatchOptions,
  firstTransportError?: unknown,
): Promise<DispatchOutcome> {
  const subjectKey = subjectDefinition.subject;
  const namespace = subjectDefinition.$meta.namespace;
  const fullSubjectKey = `${namespace}.${subjectKey}`;

  // Set the deadline on the first hop; propagate it on subsequent hops.
  const deadline = options.deadline ?? (options.timeout > 0 ? Date.now() + options.timeout : undefined);
  const remainingTimeout = deadline !== undefined ? Math.max(0, deadline - Date.now()) : options.timeout;
  const nextOptions = { ...options, deadline };

  // Deadline already elapsed — skip this remote entry instead of sending an
  // unbounded request. awaitWithTimeoutAndSignal treats timeout=0 as "no
  // timeout", so we must short-circuit here to preserve deadline semantics.
  if (deadline !== undefined && remainingTimeout === 0) {
    return stepDispatch(context, subjectDefinition, payload, merged, nextIndex, nextOptions, firstTransportError);
  }

  const transport = context.transportRegistry.getTransport(entry.transport);
  if (!transport) {
    // Transport disconnected — skip and continue at the next position.
    return stepDispatch(context, subjectDefinition, payload, merged, nextIndex, nextOptions, firstTransportError);
  }

  const requestMessage = {
    type: 'request' as const,
    subject: subjectKey,
    namespace,
    payload,
    correlationId: options.correlationId,
    messageId: options.messageId,
    timeout: remainingTimeout,
    // The cursor tells the remote node "start from handlers strictly below
    // this value". It is normally the priority of the last locally executed
    // entry (merged[nextIndex - 2]).
    //
    // Equal-priority adjustment: when the preceding entry shares the same
    // priority as this remote entry (e.g., local:100 → remote:100, or
    // remoteA:300 → remoteB:300), the base cursor would exclude
    // equal-priority handlers on the receiver because dispatch uses strict
    // `< cursor`. Incrementing by 1 includes them. This is safe because
    // priorities are integers — no handler can exist between N and N+1.
    //
    // The bump applies for both local-to-remote AND remote-to-remote ties
    // at the same priority. Without it, the second remote transport would
    // receive a cursor equal to its own priority and skip its handlers.
    //
    // When nothing preceded (nextIndex < 2), forward the incoming cursor
    // unchanged so the remote continues from where the originating node left off.
    priority: (() => {
      if (nextIndex < 2) return options.priority;
      const base = merged[nextIndex - 2].priority;
      // Bump when the preceding entry (local or remote) shares the same
      // priority as this remote entry, so the receiver includes handlers
      // at that tier.
      return base === entry.priority ? base + 1 : base;
    })(),
    deadline,
  };

  const { signal } = options;

  try {
    if (signal?.aborted) {
      throw toAbortError(signal.reason);
    }

    const result = await awaitWithTimeoutAndSignal(
      transport.send(requestMessage, remainingTimeout),
      remainingTimeout,
      signal,
    );
    return { handled: true, value: result };
  } catch (error) {
    // Abort signal fired — cancel the in-flight transport request and rethrow immediately
    // so the caller receives the abort error rather than a transport error.
    if (signal?.aborted) {
      transport.cancelRequest?.(options.correlationId, error instanceof Error ? error : toAbortError(signal.reason));
      throw error instanceof Error ? error : toAbortError(signal.reason);
    }

    if (isNoHandlerErrorForSubject(error, fullSubjectKey)) {
      // Remote chain exhausted — continue to the next entry in our list.
      return stepDispatch(context, subjectDefinition, payload, merged, nextIndex, nextOptions, firstTransportError);
    }

    // Transient transport error — log it, skip this entry, try the next.
    // Capture the first such error so it can be rethrown if the chain produces no result.
    console.error(
      `[${options.correlationId}][${options.messageId}] Error sending request "${subjectKey}" via transport '${entry.transport}':`,
      error,
    );
    return stepDispatch(
      context,
      subjectDefinition,
      payload,
      merged,
      nextIndex,
      nextOptions,
      firstTransportError ?? error,
    );
  }
}

/**
 * Priority-ordered dispatch with local/remote interleaving.
 *
 * Merges local handler entries with remote handler pointers from the remote registry
 * into a single priority-ordered list, then walks it entry by entry. Each entry is
 * executed in sequence: a handler calling `ctx.next()` advances to the next position
 * in the merged list, naturally interleaving local and remote handlers by priority.
 *
 * When entering from a transport message with a priority cursor (`options.priority`),
 * entries at or above that priority are skipped so this node picks up where the
 * originating node left off.
 *
 * Tie-breaking: local entries run before remote entries at equal priority, avoiding
 * unnecessary network hops.
 * @param context - Bus context
 * @param subjectDefinition - Subject definition (`$meta.local`, namespace, etc.)
 * @param payload - Request payload (may be replaced by a handler via `ctx.replacePayload()`)
 * @param options - Dispatch options including an optional priority cursor
 * @returns Outcome indicating whether a handler produced a result
 */
export async function dispatch(
  context: MakaioBusContext,
  subjectDefinition: SubjectDefinition,
  payload: unknown,
  options: DispatchOptions,
): Promise<DispatchOutcome> {
  const fullSubjectKey = getFullSubjectForSubjectDefinition(subjectDefinition);

  const localEntries = getMatchingHandlerEntries(context, fullSubjectKey);

  // Remote entries are skipped for local-only subjects or an explicit localOnly flag.
  const remoteEntries =
    subjectDefinition.$meta.local || options.localOnly
      ? []
      : resolveRemoteEntries(context, getMatchingRemoteEntries(context, fullSubjectKey), options.allowedTransports);

  const merged = buildMergedList(localEntries, remoteEntries);

  // When entering from a transport message with a priority cursor, find the first
  // entry that falls strictly below that priority. This is where this node begins.
  const cursor = options.priority;
  const startIndex = cursor !== undefined ? merged.findIndex((e) => e.priority < cursor) : 0;

  // Lazy readiness gate: if transports are still completing subscribe-sync, wait for them
  // and rebuild the merged list before dispatching. This covers the race where a request
  // fires before remoteRequestHandlers is fully populated.
  //
  // The gate fires for ALL non-local requests when pending transports exist, not only
  // when the initial merged list is empty. A local handler may be present while
  // lower-priority remote handlers have not yet synced; without the gate those remote
  // entries would be silently absent from the merged list, producing an incomplete chain.
  //
  // Bounding semantics:
  //   - Direct callers (request.ts): bounded by `options.timeout` / `options.signal`.
  //   - Relay hops (handleRequestMessage in transport-registry.ts): `options.timeout` is
  //     the wire-propagated remaining budget, so the gate is bounded by the caller's
  //     remaining time. Relay hops should rarely reach this gate in practice — a node
  //     receiving relay traffic should already have its transports initialised.
  //   - `timeout === 0`: disables the cap (no-timeout callers accept an unbounded wait).
  //
  // getPendingReady() returns [] in steady state (all transports ready), so the inner
  // block is never entered after startup — zero runtime cost on the hot path.
  if (!subjectDefinition.$meta.local && !options.localOnly) {
    const pending = context.transportRegistry.getPendingReady();
    if (pending.length > 0) {
      await awaitWithTimeoutAndSignal(Promise.allSettled(pending), options.timeout, options.signal);
      // Rebuild from scratch — remoteRequestHandlers may now be populated after
      // subscribe-sync completes.
      const retryRemote = resolveRemoteEntries(
        context,
        getMatchingRemoteEntries(context, fullSubjectKey),
        options.allowedTransports,
      );
      const retryMerged = buildMergedList(localEntries, retryRemote);
      if (retryMerged.length === 0) return { handled: false };
      const retryCursor = options.priority;
      const retryStartIndex = retryCursor !== undefined ? retryMerged.findIndex((e) => e.priority < retryCursor) : 0;
      if (retryStartIndex === -1) return { handled: false };
      return stepDispatch(context, subjectDefinition, payload, retryMerged, retryStartIndex, options);
    }
  }

  // No pending transports — dispatch against the already-built merged list.
  // All entries are at or above the cursor means this node's chain is exhausted.
  if (startIndex === -1 || merged.length === 0) {
    return { handled: false };
  }

  return stepDispatch(context, subjectDefinition, payload, merged, startIndex, options);
}
