import { abortableWait } from '@makaio/utils';

const maxTimerDelayMs = 2 ** 31 - 1;

interface PreparationLifetime {
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  /** Tighten the active deadline without extending it. */
  shorten(deadline: number): void;
}

/**
 * Bound all preparation work, including the first credential lookup.
 * @param deadline - Trusted absolute connection deadline in milliseconds since the epoch.
 * @param hostSignal - Host operation lifetime.
 * @param work - Preparation work with access to the same deadline guard.
 * @returns Prepared work, or undefined when the attempt's lifetime ends.
 */
export async function withinPreparationDeadline<T>(
  deadline: number,
  hostSignal: AbortSignal,
  work: (lifetime: PreparationLifetime) => Promise<T | undefined>,
): Promise<T | undefined> {
  const controller = new AbortController();
  const signal = AbortSignal.any([hostSignal, controller.signal]);
  let expiresAt = deadline;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Arm against the absolute deadline, including dates beyond the platform timer range. */
  function arm(): void {
    const remaining = expiresAt - Date.now();
    if (!(remaining > 0)) controller.abort();
    else timer = setTimeout(arm, Math.min(remaining, maxTimerDelayMs));
  }
  const lifetime: PreparationLifetime = {
    signal,
    get expiresAt() {
      return expiresAt;
    },
    shorten(bound) {
      signal.throwIfAborted();
      expiresAt = Math.min(expiresAt, bound);
      clearTimeout(timer);
      arm();
    },
  };
  arm();
  try {
    if (signal.aborted) return undefined;
    const prepared = await abortableWait(
      Promise.resolve().then(() => work(lifetime)),
      signal,
    );
    return !signal.aborted && expiresAt > Date.now() ? prepared : undefined;
  } catch (error) {
    if (!signal.aborted && expiresAt > Date.now()) throw error;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
