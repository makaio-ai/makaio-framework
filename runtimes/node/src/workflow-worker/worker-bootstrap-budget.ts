import { TimeoutError } from '@makaio/bus-core';
import { WorkerBootstrapDeadlineAtSchema } from '@makaio/contracts/worker';

/** The immutable Attempt bootstrap budget has elapsed. */
export class BootstrapDeadlineExceededError extends Error {
  public readonly code = 'WORKER_BOOTSTRAP_DEADLINE_EXCEEDED';

  public constructor() {
    super('Worker bootstrap deadline exceeded');
    this.name = 'BootstrapDeadlineExceededError';
  }
}

/** Local view of the persisted absolute bootstrap deadline. */
export interface BootstrapBudget {
  readonly deadline: number;
  readonly signal: AbortSignal;
}

/**
 * Reject absent or invalid absolute timestamps before acquiring a session.
 * @param timestamp - Persisted ISO timestamp, never a relative timeout.
 * @param signal - Caller cancellation.
 * @returns Validated local budget.
 */
export function createBootstrapBudget(timestamp: string, signal: AbortSignal): BootstrapBudget {
  if (!WorkerBootstrapDeadlineAtSchema.safeParse(timestamp).success) {
    throw new TypeError('bootstrapDeadlineAt must be a valid absolute ISO timestamp');
  }
  const budget = { deadline: Date.parse(timestamp), signal };
  assertBootstrapActive(budget);
  return budget;
}

/**
 * Bound a bootstrap callback without adding reconnect or retry semantics.
 * @param bootstrapDeadlineAt - The Attempt's immutable absolute ISO deadline.
 * @param signal - Caller cancellation.
 * @param operation - Callback receiving cancellation bounded by that deadline.
 * @returns The timely callback result.
 */
export function withWorkerBootstrapDeadline<T>(
  bootstrapDeadlineAt: string,
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const budget = createBootstrapBudget(bootstrapDeadlineAt, signal);
  return withinBootstrapBudget(budget, budget.deadline - Date.now(), operation);
}

/**
 * Cancellation and total expiry dominate transport retry classification.
 * @param budget - Unrenewable bootstrap budget.
 */
export function assertBootstrapActive(budget: BootstrapBudget): void {
  budget.signal.throwIfAborted();
  if (Date.now() >= budget.deadline) throw new BootstrapDeadlineExceededError();
}

/**
 * Bound one asynchronous phase even when an adapter ignores its AbortSignal.
 * The adapter retains ownership of cancellation-safe cleanup of its resources.
 * @param budget - Unrenewable bootstrap budget.
 * @param maximumMs - Maximum duration of this phase.
 * @param operation - Phase implementation receiving its remaining lease and cancellation.
 * @returns Timely phase result.
 */
export async function withinBootstrapBudget<T>(
  budget: BootstrapBudget,
  maximumMs: number,
  operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
): Promise<T> {
  assertBootstrapActive(budget);
  const timeoutMs = Math.min(maximumMs, budget.deadline - Date.now());
  const phaseDeadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = (): void => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      controller.abort(budget.signal.reason);
      reject(budget.signal.reason);
    };
    budget.signal.addEventListener('abort', onAbort, { once: true });
    const expire = (): void => {
      const remaining = phaseDeadline - Date.now();
      if (remaining > 0) {
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        return;
      }
      const error =
        Date.now() >= budget.deadline
          ? new BootstrapDeadlineExceededError()
          : new TimeoutError('worker bootstrap', timeoutMs);
      controller.abort(error);
      reject(error);
    };
    timer = setTimeout(expire, Math.min(timeoutMs, 2_147_483_647));
  });
  try {
    const pending = Promise.resolve().then(() => {
      assertBootstrapActive(budget);
      return operation(controller.signal, timeoutMs);
    });
    const result = await Promise.race([interrupted, pending]);
    assertBootstrapActive(budget);
    if (Date.now() >= phaseDeadline) throw new TimeoutError('worker bootstrap', timeoutMs);
    return result;
  } catch (error) {
    controller.abort(error);
    assertBootstrapActive(budget);
    throw error;
  } finally {
    clearTimeout(timer);
    budget.signal.removeEventListener('abort', onAbort);
  }
}
