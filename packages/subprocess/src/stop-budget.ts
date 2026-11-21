/**
 * The time a stopped child may take, and the one place its defaults live.
 * @packageDocumentation
 */

import { nonNegativeOption } from '@makaio/utils';
import type { ProcessStopTiming } from './types.js';

/**
 * Default drain window. Conservative: a final response a descendant writes
 * shortly after the child exited is still delivered; only a stalled or
 * inherited pipe ever waits this long.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;
/** Default time between `SIGTERM` and `SIGKILL`. */
export const DEFAULT_KILL_GRACE_MS = 5_000;
/** Default wait for the exit after the forceful stage. */
export const DEFAULT_EXIT_OBSERVATION_MS = 2_000;

/**
 * Time between `SIGTERM` and `SIGKILL` of a bounded command (`launch`). Short: a command that
 * outlived its own bound is not given time to wind down.
 */
export const LAUNCH_KILL_GRACE_MS = 200;
/** Time a bounded command's exit is awaited after the forceful stage. */
export const LAUNCH_EXIT_OBSERVATION_MS = 2_000;
/**
 * Longest time a bounded command's output is drained after its leader exited. Fixed: no stop timing shortens
 * it, so what a descendant still writes shortly after the leader's exit is captured.
 */
export const LAUNCH_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Longest time one owned child takes to end once its stop was requested: the
 * forceful stage's delivery, the exit observation after it, and the output
 * drain after the exit. Every phase is bounded by its own limit, so the sum is
 * the bound of the whole stop.
 *
 * The delivery is the graceful stage on POSIX (the kill grace) and the
 * `taskkill` run on Windows, which is bounded by the exit observation time and
 * after which the exit observation starts. The budget takes the longer of the
 * two, so it holds on either platform also when the kill grace is shorter than
 * the observation window. Omitted fields take the transport's defaults,
 * which makes the result the budget of a stop that was given no timing.
 *
 * A caller that waits for several children one after the other adds one budget
 * per child; a caller that waits for something it cannot enumerate uses this
 * as the unit of one bounded stop.
 * @param timing - Stop timing of the child; omitted fields take the defaults.
 * @returns The bound, in milliseconds.
 * @throws RangeError when a field is negative, infinite or `NaN`.
 */
export function processStopBudgetMs(timing: ProcessStopTiming = {}): number {
  const killGraceMs = nonNegativeOption('killGraceMs', timing.killGraceMs, DEFAULT_KILL_GRACE_MS);
  const exitObservationMs = nonNegativeOption(
    'exitObservationMs',
    timing.exitObservationMs,
    DEFAULT_EXIT_OBSERVATION_MS,
  );
  const drainTimeoutMs = nonNegativeOption('drainTimeoutMs', timing.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS);
  return Math.max(killGraceMs, exitObservationMs) + exitObservationMs + drainTimeoutMs;
}
