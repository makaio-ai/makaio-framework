/**
 * Async test helpers shared between vitest and bun:test.
 *
 * Provides `waitFor` (assert-callback retry loop) and `advanceTimersByTimeAsync`
 * (fake timer advancement with microtask flush).
 */

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
}

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const jest: { advanceTimersByTime(ms: number): void } | undefined;

export async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  if (typeof jest !== 'undefined' && jest?.advanceTimersByTime) {
    jest.advanceTimersByTime(ms);
  }
  await Promise.resolve();
  await Promise.resolve();
}
