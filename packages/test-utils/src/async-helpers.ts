/**
 * Async test helpers for bun:test.
 *
 * Provides `waitFor` (assert-callback retry loop) and `advanceTimersByTimeAsync`
 * (fake timer advancement with microtask flush) — filling gaps between vitest
 * and bun:test APIs.
 */

import { jest } from 'bun:test';

/**
 * Options for {@link waitFor}.
 */
export interface WaitForOptions {
  /** Maximum time to wait before rejecting, in ms. Defaults to 1000. */
  timeout?: number;
  /** Polling interval between retries, in ms. Defaults to 16. */
  interval?: number;
}

/**
 * Retry a callback until it completes without throwing.
 *
 * Matches the vitest `vi.waitFor` contract: the callback is called repeatedly;
 * if it throws (or returns a rejected promise), it is retried after `interval`
 * ms. When the callback succeeds, the returned promise resolves. If `timeout`
 * elapses first, the promise rejects with the **last** error thrown by the
 * callback so the assertion failure message is visible in the test output.
 *
 * Uses `Date.now()` for the deadline (real wall clock), so it works correctly
 * both with and without fake timers — but note that with fake timers the
 * internal polling `setTimeout` is captured by the fake clock. Tests that
 * combine `waitFor` with fake timers must advance the clock externally.
 * @param fn - Callback that throws (or rejects) when the condition is not met.
 * @param options - Timeout and polling interval overrides.
 */
export async function waitFor(fn: () => void | Promise<void>, options?: WaitForOptions): Promise<void> {
  const timeout = options?.timeout ?? 1000;
  const interval = options?.interval ?? 16;
  const deadline = Date.now() + timeout;
  let lastError: unknown;

  while (true) {
    try {
      await fn();
      return;
    } catch (err) {
      lastError = err;
    }

    if (Date.now() >= deadline) {
      throw lastError;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Advance bun/jest fake timers by `ms`, then flush the microtask queue.
 *
 * Bun's `jest.advanceTimersByTime` is synchronous — timer callbacks fire
 * inline but their promise continuations (`.then` chains) are queued as
 * microtasks. Two sequential `await Promise.resolve()` checkpoints drain
 * both first-level and chained microtask continuations.
 * @param ms - Milliseconds to advance the fake clock.
 */
export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
}
