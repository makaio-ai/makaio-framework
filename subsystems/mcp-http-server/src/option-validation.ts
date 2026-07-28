/**
 * Eager validation for the endpoint's numeric options.
 *
 * Every option here is consumed lazily — on the first request, or on a timer
 * tick minutes later — so an invalid value would otherwise surface far from the
 * call that supplied it. Validating at construction keeps the blame on the
 * caller.
 */

/** Maximum tool-execution timeout accepted by the MCP bridge (30 minutes). */
export const MAX_MCP_TOOL_EXECUTION_TIMEOUT_MS = 30 * 60_000;

/**
 * Validate an optional MCP tool execution timeout.
 * @param timeoutMs - Configured timeout in milliseconds.
 * @returns The validated timeout, or `undefined` to retain the bus default.
 */
export function validateToolExecutionTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_MCP_TOOL_EXECUTION_TIMEOUT_MS) {
    throw new RangeError(
      `toolExecutionTimeoutMs must be a positive safe integer no greater than ${MAX_MCP_TOOL_EXECUTION_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

/**
 * Validate an optional millisecond duration.
 *
 * A malformed duration here is destructive rather than merely ignored: a `NaN`
 * idle timeout makes every cutoff comparison false, so nothing is ever reaped,
 * and a non-positive one condemns every session the moment it is created.
 * Neither failure points back at the option that caused it, so both are refused
 * up front.
 * @param durationMs - Configured duration in milliseconds.
 * @param optionName - Option name reported in the error message.
 * @returns The validated duration, or `undefined` to retain the default.
 */
export function validateDurationOption(durationMs: number | undefined, optionName: string): number | undefined {
  if (durationMs === undefined) return undefined;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError(`${optionName} must be a positive finite number of milliseconds`);
  }
  return durationMs;
}

/**
 * Largest delay the runtime schedules faithfully (2^31 - 1 ms); longer delays
 * are coerced to 1ms by the runtime's timer implementation.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Validate an optional duration that is handed to a timer as its delay.
 *
 * Adds the 32-bit timer ceiling to {@link validateDurationOption}, because a
 * larger delay is silently coerced to 1ms: a "30-day sweep" would become a
 * tight reaper loop that no finite-only check can catch. The ceiling belongs to
 * the timer, not to duration options in general — a duration that is only ever
 * compared against the clock can legitimately span months.
 * @param delayMs - Configured timer delay in milliseconds.
 * @param optionName - Option name reported in the error message.
 * @returns The validated delay, or `undefined` to retain the default.
 */
export function validateTimerDelayOption(delayMs: number | undefined, optionName: string): number | undefined {
  const validated = validateDurationOption(delayMs, optionName);
  if (validated !== undefined && validated > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${optionName} must be no greater than ${MAX_TIMER_DELAY_MS} milliseconds`);
  }
  return validated;
}
