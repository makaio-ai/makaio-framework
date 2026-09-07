import type { ExecutionAttemptBootstrapAwaitStartResponse } from '@makaio/contracts';
import type {
  BootstrapStartState,
  ExecutionAttemptRepository,
  ReadBootstrapStartStateInput,
} from './execution-attempt-repository.js';

/** A single bounded observation, not a new bootstrap budget. */
export interface BootstrapStartOptions {
  /** Request cancellation or owner shutdown. */
  readonly signal: AbortSignal;
  /** Absolute request deadline in Unix milliseconds. */
  readonly deadline: number;
}

/** Start authorization shared by credential ingress and authenticated runtime ingress. */
export interface BootstrapStartAuthority {
  /**
   * Observe the durable allocation before entering runtime registration.
   * @param identity - Trusted owner and attempt identity.
   * @param options - Cancellation and the current request's deadline.
   */
  awaitBootstrapStart(
    identity: ReadBootstrapStartStateInput,
    options: BootstrapStartOptions,
  ): Promise<ExecutionAttemptBootstrapAwaitStartResponse>;
}

const LEASE_MS = 30_000;
const RESPONSE_MARGIN_MS = 1_000;
// Level-triggered observation bounds propagation latency without requiring notifications.
const POLL_INTERVAL_MS = 100;

/**
 * Apply the common refusal precedence to a coherent durable observation.
 * @param state - Owner-scoped repository facts.
 * @returns Current permission, refusal, or a renewable pending decision.
 */
function evaluateStart(state: BootstrapStartState | null): ExecutionAttemptBootstrapAwaitStartResponse {
  if (state === null) return { status: 'refused', reason: 'not-found' };
  if (state.settled) return { status: 'refused', reason: 'resolved' };
  if (!state.active) return { status: 'refused', reason: 'fenced' };
  if (state.allocationTerminated) return { status: 'refused', reason: 'allocation-terminated' };
  if (state.operationStartGate === 'closed') return { status: 'refused', reason: 'gate-closed' };
  const deadline = state.bootstrapDeadlineAt === null ? NaN : Date.parse(state.bootstrapDeadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return { status: 'refused', reason: 'bootstrap-expired' };
  return { status: state.allocated ? 'permitted' : 'pending' };
}

/**
 * Bound an asynchronous repository read even when its implementation cannot cancel I/O.
 * @param operation - Read whose late rejection must remain observed.
 * @param signal - Call-scoped cancellation with a hard deadline.
 * @returns The read result unless this call has ended.
 */
function readUntilCancelled<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Sleep only until the next observation or cancellation; release both resources.
 * @param milliseconds - Time until the next durable read.
 * @param signal - Call-scoped cancellation.
 */
function waitForObservation(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/**
 * Bound storage observation, leaving at most the existing response margin for the final read.
 * @param controller - Call-scoped timeout cancellation.
 * @param deadline - Absolute last instant this request may retain an observation.
 * @returns Timer owned and disposed by the caller.
 */
function armObservationTimeout(controller: AbortController, deadline: number): ReturnType<typeof setTimeout> {
  return setTimeout(
    () => controller.abort(new Error('Bootstrap start observation timed out')),
    Math.max(0, deadline - Date.now()),
  );
}

/**
 * Wait for allocation using only durable facts; each request has a finite lease.
 * @param repository - Required owner-scoped observation port.
 * @param identity - Trusted owner and attempt identity.
 * @param options - Caller cancellation and request deadline, never provider policy.
 * @returns A permission, terminal refusal, or pending response for a new request.
 */
export async function awaitBootstrapStart<TOutcome>(
  repository: ExecutionAttemptRepository<TOutcome>,
  identity: ReadBootstrapStartStateInput,
  options: BootstrapStartOptions,
): Promise<ExecutionAttemptBootstrapAwaitStartResponse> {
  options.signal.throwIfAborted();
  if (!Number.isFinite(options.deadline)) throw new Error('Bootstrap start request requires a finite deadline');
  const leaseDeadline = Math.min(Date.now() + LEASE_MS, options.deadline - RESPONSE_MARGIN_MS);
  const timeout = new AbortController();
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  const requestDeadline = Math.min(options.deadline, leaseDeadline + RESPONSE_MARGIN_MS);
  let timer = armObservationTimeout(timeout, requestDeadline);
  try {
    while (true) {
      signal.throwIfAborted();
      const state = await readUntilCancelled(repository.readBootstrapStartState(identity), signal);
      signal.throwIfAborted();
      const decision = evaluateStart(state);
      if (decision.status !== 'pending') return decision;
      const durableDeadline = Date.parse(state?.bootstrapDeadlineAt ?? '');
      // Once known, the immutable deadline also bounds later stalled reads.
      // The final read keeps only the existing response margin, never a fresh lease.
      clearTimeout(timer);
      timer = armObservationTimeout(timeout, Math.min(requestDeadline, durableDeadline + RESPONSE_MARGIN_MS));
      // This read is also the final authoritative observation after lease expiry.
      const remaining = Math.min(leaseDeadline, durableDeadline) - Date.now();
      if (remaining <= 0) return decision;
      await waitForObservation(Math.min(POLL_INTERVAL_MS, remaining), signal);
    }
  } finally {
    clearTimeout(timer);
  }
}
