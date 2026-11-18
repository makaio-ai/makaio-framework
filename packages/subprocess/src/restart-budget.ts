/**
 * Budget for automatic restarts of a supervised child.
 *
 * A child that crashes right after it became ready would otherwise be
 * restarted forever. The budget allows at most `maxRestarts` automatic restarts
 * within a sliding window of `windowMs` and spaces them out: the first restart
 * in the window waits `initialDelayMs`, every further one twice as long as the
 * one before, up to `maxDelayMs`. Once the window holds `maxRestarts` restarts,
 * the next request is refused until the oldest one has left the window.
 */
import { nonNegativeOption } from '@makaio/utils';

/** Limits of automatic restarts; every field has a default. */
export interface RestartBudgetOptions {
  /** Most automatic restarts within {@link windowMs}. Defaults to 5. */
  readonly maxRestarts?: number;
  /** Length of the sliding window, in milliseconds. Defaults to 60000. */
  readonly windowMs?: number;
  /** Delay before the first restart in the window, in milliseconds; doubles for every further one. Defaults to 500. */
  readonly initialDelayMs?: number;
  /** Longest delay before a restart, in milliseconds. Defaults to 10000. */
  readonly maxDelayMs?: number;
}

/** Answer to a restart request: when to restart, or that the budget is used up. */
export type RestartGrant = { readonly kind: 'granted'; readonly delayMs: number } | { readonly kind: 'exhausted' };

/** Automatic restarts granted so far, counted over a sliding window. */
export interface RestartBudget {
  /** Most automatic restarts within {@link windowMs}. */
  readonly maxRestarts: number;
  /** Length of the sliding window, in milliseconds. */
  readonly windowMs: number;
  /**
   * Ask for one automatic restart. A granted restart counts against the budget
   * from now on.
   * @returns The delay before the restart, or `exhausted`.
   */
  claim(): RestartGrant;
}

/**
 * Create a restart budget.
 * @param options - Limits; omitted fields take their defaults.
 * @param now - Clock in epoch milliseconds; defaults to `Date.now`.
 * @returns The budget.
 */
export function createRestartBudget(options: RestartBudgetOptions = {}, now: () => number = Date.now): RestartBudget {
  const maxRestarts = nonNegativeOption('maxRestarts', options.maxRestarts, 5);
  if (!Number.isInteger(maxRestarts)) throw new RangeError('maxRestarts must be an integer');
  const windowMs = nonNegativeOption('windowMs', options.windowMs, 60_000);
  const initialDelayMs = nonNegativeOption('initialDelayMs', options.initialDelayMs, 500);
  const maxDelayMs = nonNegativeOption('maxDelayMs', options.maxDelayMs, 10_000);
  /** When each restart in the window was granted, oldest first. */
  const granted: number[] = [];

  return {
    maxRestarts,
    windowMs,
    claim(): RestartGrant {
      const at = now();
      while ((granted[0] ?? Number.POSITIVE_INFINITY) <= at - windowMs) granted.shift();
      if (granted.length >= maxRestarts) return { kind: 'exhausted' };
      const delayMs = Math.min(maxDelayMs, initialDelayMs * 2 ** granted.length);
      granted.push(at);
      return { kind: 'granted', delayMs };
    },
  };
}
