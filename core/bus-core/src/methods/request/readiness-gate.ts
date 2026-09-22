/**
 * The readiness-gate seam: one bounded wait, before the chain is built.
 *
 * A request can arrive while a transport is still completing its `ready` handshake, so
 * the routes that transport will advertise are not yet in the remote registry. The gate
 * closes that startup race. Its entire contract is one rule:
 *
 * **If remote-eligible transports are pending when a dispatch starts, wait once —
 * bounded by `min(readinessTimeout, remaining deadline)` — before building the merged
 * list. Then build once and dispatch once.**
 *
 * ## No retry, ever
 *
 * Dispatch never redoes work. Not a second pass, not a replayed chain, not a re-sent
 * remote hop. Redoing work is only safe for operations known to be idempotent, and the
 * bus has no such knowledge: a handler may have written rows, a peer may have received
 * a request whose reply was merely lost, a wrapper may already have run its
 * compensation. Every attempt to recover a late-arriving route by re-running something
 * reintroduced one of those hazards under a new name. Waiting first and acting once is
 * the only version of this seam that needs no idempotence proof.
 *
 * A consequence worth stating: local handlers do **not** pre-empt the wait. A pending
 * peer may yet advertise a higher-priority handler, and the cross-transport priority
 * contract says that handler runs first. Answering locally to skip the wait would
 * quietly violate it.
 *
 * ## Bounds
 *
 * - The wait runs on `readinessTimeout` (default `DEFAULT_READINESS_TIMEOUT_MS`), never
 *   on the caller's request budget, and is additionally clamped by the remaining
 *   deadline. Budget expiry is not a failure: dispatch proceeds with whatever is
 *   advertised and emits one debug diagnostic naming the transports still pending.
 * - Deadline expiry is a failure: it raises `TimeoutError`. The deadline is resolved
 *   once per dispatch and re-checked before every chain advancement, so nothing runs
 *   after it.
 * - `getPendingReadyEntries()` is empty once transports have settled, and dispatch
 *   checks that synchronously, so the steady-state path adds no await at all.
 *
 * This is what bounds the original failure: a transport whose `ready` never settles
 * costs at most one readiness budget per request instead of the caller's whole timeout.
 * A transport that cannot complete a peer handshake should declare a readiness contract
 * it can actually reach, so the window is the connect window rather than forever.
 */

import type { PendingReadyEntry } from '../../registries/index.js';
import type { DispatchOptions } from './dispatch.js';
import { isRequestCancellation } from '../../errors/index.js';
import { awaitWithTimeoutAndSignal } from './await-with-timeout-and-signal.js';
import { TimeoutError as pTimeoutError } from 'p-timeout';
import { DEFAULT_READINESS_TIMEOUT_MS } from '../../types/options.js';

/**
 * Resolve the absolute deadline this dispatch must stay inside.
 *
 * Direct callers mint `deadline` at the request entry point and relay hops carry it
 * on the wire. When it is absent (an inbound hop whose sender sent none), the local
 * `timeout` is the only remaining budget, so it is anchored here.
 * @param options - Dispatch options carrying `deadline` and `timeout`
 * @returns Absolute deadline in epoch milliseconds, or `undefined` when unbounded
 */
export function resolveDispatchDeadline(options: DispatchOptions): number | undefined {
  if (options.deadline !== undefined) return options.deadline;
  return options.timeout > 0 ? Date.now() + options.timeout : undefined;
}

/**
 * Milliseconds left before the request deadline.
 * @param deadline - Absolute deadline, or `undefined` when the caller set none
 * @returns Remaining milliseconds, or `Infinity` when there is no deadline
 */
export function remainingUntil(deadline: number | undefined): number {
  return deadline === undefined ? Number.POSITIVE_INFINITY : deadline - Date.now();
}

/**
 * Effective readiness budget, or `'expired'` when the deadline has already passed.
 *
 * Expiry is a distinct value rather than `0` milliseconds because `0` is the
 * "no automatic timeout" sentinel of the shared wait helper. Encoding an expired
 * deadline as `0` would remove the cap entirely and let a never-settling `ready`
 * hang the wait — fatal on the inbound hop, which has no outer timeout wrapper.
 */
export type ReadinessBudget = number | 'expired';

/**
 * Bound the readiness budget by the request deadline.
 *
 * The gate runs inside `dispatch`, which the caller's `p-timeout` wrapper cannot
 * cancel, so a budget longer than the remaining request time would keep waiting —
 * and could keep running handlers — after the caller has already been rejected. Clamping
 * here keeps every side effect inside the caller's deadline.
 *
 * The remaining time is read once, so the returned number is always strictly
 * positive; callers cannot straddle the deadline between a separate check and this
 * computation.
 * @param options - Dispatch options supplying the configured budget
 * @param deadline - Absolute request deadline, or `undefined` when unbounded
 * @returns Positive budget in milliseconds, `0` for no cap (no deadline and no
 *   configured budget), or `'expired'` when the deadline has already passed
 */
export function resolveReadinessBudget(options: DispatchOptions, deadline: number | undefined): ReadinessBudget {
  const budget = options.readinessTimeout ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (deadline === undefined) return budget;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'expired';
  // `0` means "no cap" for the configured budget, so the deadline alone bounds it.
  return budget === 0 ? remaining : Math.min(budget, remaining);
}

/**
 * Wait for pending transport handshakes on the readiness gate's own budget.
 *
 * The wait is a completeness hint for the remote half of the dispatch chain, so
 * budget expiry is not an error: it resolves normally and the caller re-reads the
 * routes advertised so far. Caller cancellation still propagates — an aborted
 * request must not go on to send anything.
 *
 * The budget is validated at the public request seam, so a non-finite or negative
 * value cannot reach the timeout primitive from here.
 * @param pending - Unresolved transport `ready` entries from the registry
 * @param options - Dispatch options supplying the signal and identifiers
 * @param fullSubjectKey - Fully-qualified subject, for the expiry diagnostic
 * @param budget - Deadline-clamped budget in milliseconds; `0` means no cap
 */
export async function awaitTransportReadiness(
  pending: ReadonlyArray<PendingReadyEntry>,
  options: DispatchOptions,
  fullSubjectKey: string,
  budget: number,
): Promise<void> {
  try {
    await awaitWithTimeoutAndSignal(Promise.allSettled(pending.map((entry) => entry.ready)), budget, options.signal);
  } catch (error) {
    if (!(error instanceof pTimeoutError) || isRequestCancellation(error, options.signal)) throw error;
    console.debug('[Dispatch] Readiness budget expired, dispatching with the routes advertised so far', {
      subject: fullSubjectKey,
      correlationId: options.correlationId,
      messageId: options.messageId,
      readinessTimeoutMs: budget,
      pendingTransports: pending.map((entry) => entry.name),
    });
  }
}

/**
 * Outcome of one pass through the readiness gate.
 *
 * `skipped` means nothing was waited for, so the caller's chain is unchanged.
 * `rebuilt` means a wait completed inside the deadline and the caller must re-read
 * both halves of the merged list. `expired` means the request's deadline passed.
 */
export type ReadinessGateOutcome = 'skipped' | 'rebuilt' | 'expired';

/** What the shared readiness gate needs in order to wait. */
export interface ReadinessGateRequest {
  /** Pending transport entries to wait on. */
  pending: ReadonlyArray<PendingReadyEntry>;
  /** Dispatch options supplying the budget, signal and identifiers. */
  options: DispatchOptions;
  /** Fully-qualified subject, for the expiry diagnostic. */
  fullSubjectKey: string;
  /** The dispatch's single resolved deadline. */
  deadline: number | undefined;
}

/**
 * The single entry point into the readiness gate.
 *
 * Both gate sites — the allowlist pre-gate and the exhaustion gate — go through here,
 * so the post-wait deadline check cannot be forgotten at one of them. Invariant 4 of
 * this module's contract.
 * @param request - Pending entries, options, subject and the resolved deadline
 * @returns Whether the caller should rebuild, do nothing, or stop on an expired deadline
 */
export async function runReadinessGate(request: ReadinessGateRequest): Promise<ReadinessGateOutcome> {
  const { pending, options, fullSubjectKey, deadline } = request;
  if (pending.length === 0) return 'skipped';

  const budget = resolveReadinessBudget(options, deadline);
  // Invariant 1 is literal: an already-expired deadline stops the request here rather
  // than letting the chain run. An inbound relay hop carrying a past wire deadline has
  // no outer wrapper to catch that for us.
  if (budget === 'expired') return 'expired';

  await awaitTransportReadiness(pending, options, fullSubjectKey, budget);

  // The wait was cut short by the deadline rather than by its own budget.
  return remainingUntil(deadline) <= 0 ? 'expired' : 'rebuilt';
}
