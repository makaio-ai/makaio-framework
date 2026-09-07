import { ConnectionLostError, TimeoutError } from '@makaio/bus-core';
import { WebSocketConnectionError } from '@makaio/bus-transport-websocket';
import {
  assertBootstrapActive,
  createBootstrapBudget,
  withinBootstrapBudget,
  type BootstrapBudget,
} from './worker-bootstrap-budget.js';

export { BootstrapDeadlineExceededError, withWorkerBootstrapDeadline } from './worker-bootstrap-budget.js';

/** Valid, schema-parsed protocol response; refusal is a nonretryable adapter error. */
export type BootstrapExchangeResult<TValue> =
  | { readonly status: 'pending' }
  | { readonly status: 'complete'; readonly value: TValue };

/** Adapters keep credential and start-authorization protocols outside the session loop. */
export interface WorkerBootstrapExchangeOptions<TSession, TValue> {
  readonly bootstrapDeadlineAt: string;
  readonly signal: AbortSignal;
  /** Acquire a handle synchronously, before any asynchronous connection work. */
  readonly createSession: () => TSession;
  /** Include authentication and subscription readiness; disable transport auto-reconnect. */
  readonly connect: (session: TSession, signal: AbortSignal) => Promise<void>;
  /** Parse protocol responses before returning; throw typed refusal errors. */
  readonly exchange: (
    session: TSession,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ) => Promise<BootstrapExchangeResult<TValue>>;
  /** Revoke the handle, including pending connect, so late completion cannot revive it. */
  readonly dispose: (session: TSession) => void | Promise<void>;
}

/**
 * Connect and repeat a pre-registration exchange within one durable bootstrap budget.
 * Failed sessions are disposed before reconnecting. A successful session transfers
 * to the caller; no timer survives to affect registration or workload execution.
 * @param options - Protocol adapters and the Attempt's immutable deadline.
 * @returns Surviving session and the timely, parsed completion value.
 */
export async function runWorkerBootstrapExchange<TSession, TValue>(
  options: WorkerBootstrapExchangeOptions<TSession, TValue>,
): Promise<{ readonly session: TSession; readonly value: TValue }> {
  const budget = createBootstrapBudget(options.bootstrapDeadlineAt, options.signal);
  let backoffMs = 1000;
  while (true) {
    assertBootstrapActive(budget);
    const session = options.createSession();
    try {
      await withinBootstrapBudget(budget, 10_000, (signal) => options.connect(session, signal));
      const value = await exchangeUntilComplete(options, session, budget, () => {
        backoffMs = 1000;
      });
      assertBootstrapActive(budget);
      return { session, value };
    } catch (error) {
      try {
        await disposeUnsuccessfulSession(options, session, budget);
      } finally {
        assertBootstrapActive(budget);
      }
      if (!isRetryableBootstrapError(error)) throw error;
      await withinBootstrapBudget(budget, budget.deadline - Date.now(), (signal) =>
        waitForBootstrapTimer(Math.min(backoffMs, budget.deadline - Date.now()), signal),
      );
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
  }
}

/**
 * Pending renews on the same healthy connection and resets failure backoff.
 * @param options - Protocol adapter.
 * @param session - Connected, caller-owned handle.
 * @param budget - Unrenewable total budget.
 * @param onResponse - Record a valid protocol response.
 * @returns Complete response value.
 */
async function exchangeUntilComplete<TSession, TValue>(
  options: WorkerBootstrapExchangeOptions<TSession, TValue>,
  session: TSession,
  budget: BootstrapBudget,
  onResponse: () => void,
): Promise<TValue> {
  while (true) {
    const result = await withinBootstrapBudget(budget, 35_000, (signal, timeoutMs) =>
      options.exchange(session, { signal, timeoutMs }),
    );
    onResponse();
    if (result.status === 'complete') return result.value;
    // A responder may return pending immediately. Yield so cancellation and
    // deadline timers cannot be starved by an all-local microtask loop.
    await withinBootstrapBudget(budget, 35_000, (signal) => waitForBootstrapTimer(0, signal));
  }
}

/**
 * Invoke cleanup even when cancellation already happened; never start a fresh
 * session until it completes. The caller's deadline also bounds stalled cleanup.
 * @param options - Cleanup adapter.
 * @param session - Unsuccessful session to revoke.
 * @param budget - Original total budget.
 */
async function disposeUnsuccessfulSession<TSession, TValue>(
  options: WorkerBootstrapExchangeOptions<TSession, TValue>,
  session: TSession,
  budget: BootstrapBudget,
): Promise<void> {
  const disposed = Promise.resolve(options.dispose(session));
  // Cleanup is initiated even after expiry; observe late rejection when the
  // budget is already exhausted and therefore cannot await it.
  void disposed.catch(() => {});
  await withinBootstrapBudget(budget, budget.deadline - Date.now(), () => disposed);
}

/**
 * Only stable transport categories permit a fresh pre-registration session.
 * @param error - Failure emitted by the transport or bounded request.
 * @returns Whether reconnecting is permitted while the total budget remains.
 */
function isRetryableBootstrapError(error: unknown): boolean {
  if (error instanceof ConnectionLostError || error instanceof TimeoutError) return true;
  // bus.connect preserves a transport error as cause and copies its code onto
  // its contextual Error wrapper. Preserve that classification without trusting
  // diagnostic text or an arbitrary Error carrying only a lookalike code.
  const transportError =
    error instanceof Error &&
    error.cause instanceof WebSocketConnectionError &&
    'code' in error &&
    error.code === error.cause.code
      ? error.cause
      : error;
  return (
    transportError instanceof WebSocketConnectionError &&
    (transportError.code === 'WS_CONNECTION_UNAVAILABLE' ||
      transportError.code === 'WS_HANDSHAKE_TIMEOUT' ||
      transportError.code === 'WS_CONNECTION_TIMEOUT')
  );
}

/**
 * Yield or back off without retaining a timer after cancellation.
 * @param durationMs - Delay bounded by the enclosing bootstrap phase.
 * @param signal - Phase cancellation.
 * @returns Completion after the delay, or cancellation rejection.
 */
function waitForBootstrapTimer(durationMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
