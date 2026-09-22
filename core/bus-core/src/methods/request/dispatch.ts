import type { MakaioBusContext, WithReceiveContext } from '../../types/index.js';
import type { RequestContext, SubjectDefinition } from '@makaio/core';
import { getMatchingHandlerEntries, getMatchingRemoteEntries } from './getMatchingHandlers.js';
import {
  buildMergedList,
  resolveRemoteCursor,
  resolveRemoteEntries,
  resolveStartIndex,
  type LocalEntry,
  type MergedEntry,
  type RemoteEntry,
} from './merged-list.js';
import { getFullSubjectForSubjectDefinition } from '../../utils/subject-transformation.js';
import { isNoHandlerErrorForSubject } from '../../utils/transport.js';
import { LOCAL_ORIGIN, REMOTE_ORIGIN } from '../../utils/transport-helpers.js';
import { isRequestCancellation, RequestError, TimeoutError, toAbortError } from '../../errors/index.js';
import { awaitWithTimeoutAndSignal } from './await-with-timeout-and-signal.js';
import { remainingUntil, resolveDispatchDeadline, runReadinessGate } from './readiness-gate.js';

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
   * Budget in milliseconds for the one readiness wait, independent of `timeout` and
   * additionally clamped by `deadline`.
   *
   * Defaults to {@link DEFAULT_READINESS_TIMEOUT_MS}. `0` disables the cap.
   */
  readinessTimeout?: number;
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
  /** Exclude remote routes whose owner marked the subscription as first-hop-only. */
  excludeFirstHopOnlyRemote?: boolean;
}

/** Outcome of a dispatch attempt. */
export interface DispatchOutcome {
  /** Whether any handler produced a result. */
  handled: boolean;
  /** The result value if handled. Always present when `handled` is `true`. */
  value?: unknown;
}

/**
 * Execute one step in the merged dispatch chain.
 *
 * Picks the entry at `index`, executes it, and returns the outcome. When the list is
 * exhausted, any `firstTransportError` collected during remote dispatch is rethrown so
 * a local wrapper's `ctx.next()` rejects and its compensation runs.
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
    // Chain exhausted — rethrow the first transport error so a local wrapper's
    // `ctx.next()` rejects and its compensation runs.
    if (firstTransportError !== undefined) {
      throw firstTransportError;
    }
    return { handled: false };
  }

  // Invariant 1, enforced at every advancement rather than once per pass: a slow
  // handler can finish after the deadline, and neither its `ctx.next()` nor the
  // auto-advance may then start the next entry's side effects. This is the single
  // place the running chain is stopped; the boundary only classifies the result.
  if (remainingUntil(options.deadline) <= 0) {
    throw new TimeoutError(subjectDefinition.subject, options.timeout);
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
    origin: options.transport ? REMOTE_ORIGIN : LOCAL_ORIGIN,
    ...(options.deadline !== undefined && { deadline: options.deadline }),
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
      // The owning handler can fail before the post-handler await observes downstream work.
      void promise.catch(() => undefined);
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
    if (isRequestCancellation(error, options.signal)) {
      throw toAbortError(error);
    }
    if (error instanceof RequestError || error instanceof TimeoutError) {
      // Already wrapped, or a deadline failure whose identity the caller relies on.
      throw error;
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

  // Invariant 1: `dispatch` resolved the deadline once and wrote it into these options.
  // Re-deriving it here would give this hop a different instant from the rest of the chain.
  const { deadline } = options;
  const remainingTimeout = deadline !== undefined ? Math.max(0, deadline - Date.now()) : options.timeout;
  const nextOptions = { ...options, deadline };

  /**
   * Continue the chain past this entry without sending to it.
   * @param carriedError - Transport error to keep carrying, if any
   * @returns Outcome of the remaining chain
   */
  const skipToNext = (carriedError: unknown = firstTransportError): Promise<DispatchOutcome> =>
    stepDispatch(context, subjectDefinition, payload, merged, nextIndex, nextOptions, carriedError);

  // Deadline already elapsed — skip this remote entry instead of sending an
  // unbounded request. awaitWithTimeoutAndSignal treats timeout=0 as "no
  // timeout", so we must short-circuit here to preserve deadline semantics.
  if (deadline !== undefined && remainingTimeout === 0) return skipToNext();

  const transport = context.transportRegistry.getTransport(entry.transport);
  // Transport disconnected — skip and continue at the next position.
  if (!transport) return skipToNext();

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
    priority: resolveRemoteCursor(merged, nextIndex, entry.priority, options.priority),
    deadline,
    // Carry the caller's readiness budget so the next hop gates on it rather than
    // silently falling back to the default.
    ...(options.readinessTimeout !== undefined && { readinessTimeout: options.readinessTimeout }),
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
    // Only this request's cancellation may be forwarded to the transport as cancellation.
    // A concurrent independent failure must not be relabeled because the signal aborted.
    if (isRequestCancellation(error, signal)) {
      const abortError = toAbortError(error);
      transport.cancelRequest?.(options.correlationId, abortError);
      throw abortError;
    }

    // Cancellation closes fallback admission without changing an independent error's provenance.
    if (signal?.aborted) throw error;

    if (isNoHandlerErrorForSubject(error, fullSubjectKey)) {
      // Remote chain exhausted — continue to the next entry in our list.
      return skipToNext();
    }

    // Transient transport error — log it, skip this entry, try the next.
    // Capture the first such error so it can be rethrown if the chain produces no result.
    console.error(
      `[${options.correlationId}][${options.messageId}] Error sending request "${subjectKey}" via transport '${entry.transport}':`,
      error,
    );
    return skipToNext(firstTransportError ?? error);
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

  // Resolve the deadline once and write it into the options every later step sees, so
  // the chain, each handler context and each remote hop share one instant.
  const deadline = resolveDispatchDeadline(options);
  const dispatchOptions: DispatchOptions = options.deadline === deadline ? options : { ...options, deadline };
  if (remainingUntil(deadline) <= 0) throw new TimeoutError(subjectDefinition.subject, dispatchOptions.timeout);

  // Remote entries are skipped for local-only subjects or an explicit localOnly flag.
  const remoteEligible = !subjectDefinition.$meta.local && !options.localOnly;

  // The readiness gate: one bounded wait, before the chain is built. Local handlers do
  // not pre-empt it — a pending peer may yet advertise a higher-priority handler, and
  // the cross-transport priority contract says that handler runs first. See the seam
  // contract in `readiness-gate.ts` for why waiting first is the whole design.
  const pending = remoteEligible
    ? context.transportRegistry.getPendingReadyEntries(dispatchOptions.allowedTransports)
    : [];
  // Checked synchronously: in steady state nothing is pending, and dispatch must not
  // even add a microtask there — handler/cancellation orderings are observable.
  if (pending.length > 0) {
    const gate = await runReadinessGate({ pending, options: dispatchOptions, fullSubjectKey, deadline });
    if (gate === 'expired') throw new TimeoutError(subjectDefinition.subject, dispatchOptions.timeout);
  }

  // Built once, after the wait, and dispatched once.
  const remoteEntries = remoteEligible
    ? resolveRemoteEntries(
        context,
        getMatchingRemoteEntries(context, fullSubjectKey, options.excludeFirstHopOnlyRemote),
        options.allowedTransports,
      )
    : [];
  const merged = buildMergedList(getMatchingHandlerEntries(context, fullSubjectKey), remoteEntries);
  // When entering from a transport message with a priority cursor, this node begins at
  // the first entry strictly below that priority.
  const startIndex = resolveStartIndex(merged, options.priority);
  if (startIndex === -1 || merged.length === 0) return { handled: false };

  return stepDispatch(context, subjectDefinition, payload, merged, startIndex, dispatchOptions);
}
