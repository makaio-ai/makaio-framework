/**
 * Waiting on work whose own duration is not under the waiter's control.
 * @packageDocumentation
 */

/**
 * Longest delay a Node timer takes. A longer one fires after 1 ms instead, which
 * would end a window the moment it opens.
 */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** What {@link boundedWait} found when its window closed. */
export type BoundedWaitOutcome<T> =
  | {
      /** The work settled inside its window. */
      readonly settled: true;
      /** What the work resolved with. */
      readonly value: T;
    }
  | {
      /** The window closed first; the work is still running and nobody observes it any more. */
      readonly settled: false;
    };

/**
 * Wait for work for at most `windowMs`.
 *
 * The bound applies to the wait, not to the work: when the window closes first
 * the work keeps running and its eventual outcome, rejection included, is
 * discarded. A caller that owns a resource behind the work is responsible for
 * what is left of it. The timer is always cleared, so the window never keeps
 * the event loop alive past the work's settlement.
 * @param work - Work to wait for.
 * @param windowMs - Length of the window in milliseconds; capped at the longest timer delay.
 * @returns The work's value when it settled inside the window, otherwise a report that the window closed first.
 * @throws The work's rejection when it rejects inside the window.
 */
export async function boundedWait<T>(work: PromiseLike<T>, windowMs: number): Promise<BoundedWaitOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<{ readonly settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), Math.min(windowMs, MAX_TIMER_DELAY_MS));
  });
  const observed = Promise.resolve(work).then((value) => ({ settled: true as const, value }));
  try {
    return await Promise.race([observed, closed]);
  } finally {
    clearTimeout(timer);
    // The loser of the race stays observed, so a late rejection is no unhandled one.
    observed.catch(() => undefined);
  }
}

/**
 * Scheduling headroom an outer bound adds on top of the bounds of the work it
 * wraps. Work that bounds itself arms its timers only after the wrapper armed
 * its own (a lane to wait for, a hop to the next turn), so a wrapper whose window
 * is exactly the sum of the inner windows closes first when the inner work uses
 * them in full and reports a stop that was still within its limits as failed.
 */
export const OUTER_BOUND_HEADROOM_MS = 1_000;

/**
 * The window of a bound wrapped around work that already bounds itself. Every
 * such wrapper uses this rule: it is a backstop for work that does not hold to
 * its own bounds, never the thing that limits work that does.
 * @param innerBoundMs - What the inner bounds add up to, in milliseconds.
 * @returns The window of the wrapper, in milliseconds.
 */
export function outerBoundMs(innerBoundMs: number): number {
  return innerBoundMs + OUTER_BOUND_HEADROOM_MS;
}

/** What {@link boundedWaitReread} found when its window closed for good. */
export type RereadWaitOutcome<T> =
  | {
      /** The work settled inside its window. */
      readonly settled: true;
      /** What the work resolved with. */
      readonly value: T;
    }
  | {
      /** The window, as last read, closed first; the work is still running and nobody observes it any more. */
      readonly settled: false;
      /** The window that closed, in milliseconds. */
      readonly windowMs: number;
    };

/**
 * Wait for work inside a window that is read again whenever it closes.
 *
 * A window that is a sum over what the work itself registers (the extensions it
 * will stop, the steps a boot has appended so far) can grow while the work runs:
 * work that was in flight when the window was first read may still register
 * something to release. When the window closes, it is read once more, and the
 * wait goes on for the difference if the window has grown meanwhile. It ends for
 * good as soon as a read finds the window no larger than the time already waited,
 * so work that registers nothing is still cut off at the window it started with.
 * @param startWork - Starts the work; called right after the window was first read, so what the work itself changes at its start is not yet in that read.
 * @param readWindowMs - Reads the window in milliseconds; called when the wait starts and each time the window closes.
 * @returns The work's value when it settled inside its window, otherwise the window that closed first.
 * @throws The work's rejection when it rejects inside the window, or the error `startWork` throws.
 */
export async function boundedWaitReread<T>(
  startWork: () => PromiseLike<T>,
  readWindowMs: () => number,
): Promise<RereadWaitOutcome<T>> {
  let windowMs = readWindowMs();
  const work = startWork();
  let outcome = await boundedWait(work, windowMs);
  while (!outcome.settled) {
    const grown = readWindowMs();
    if (!(grown > windowMs)) return { settled: false, windowMs };
    outcome = await boundedWait(work, grown - windowMs);
    windowMs = grown;
  }
  return outcome;
}

/**
 * Stop waiting for work as soon as a signal aborts.
 *
 * Like {@link boundedWait} this bounds the wait only: an aborted wait leaves the
 * work running, so a caller that owns what the work builds must release it on
 * rejection. An already aborted signal rejects without waiting.
 * @param work - Work to wait for.
 * @param signal - Cancels the wait; `undefined` waits for the work alone.
 * @returns The work's value.
 * @throws The signal's reason when it aborts first, the work's rejection otherwise.
 */
export async function abortableWait<T>(work: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const observed = Promise.resolve(work);
  try {
    return await Promise.race([observed, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    observed.catch(() => undefined);
  }
}
