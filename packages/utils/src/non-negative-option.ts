/**
 * Validation of numeric options that are durations or counts.
 * @packageDocumentation
 */

/**
 * Report whether a value is usable as a duration or a count: a finite number
 * that is not negative. The one rule {@link nonNegativeOption} enforces, for
 * callers that must tell the two apart without throwing.
 * @param value - Value to check.
 * @returns `true` for zero and every positive finite number.
 */
export function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Resolve a numeric option that must be a non-negative finite number, such as a
 * duration or a count.
 * @param name - Option name for the error.
 * @param value - Configured value, if any.
 * @param fallback - Default when not configured.
 * @returns The configured value, or the fallback.
 * @throws RangeError when the resolved value is negative, infinite or `NaN`.
 */
export function nonNegativeOption(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!isNonNegativeFinite(resolved)) throw new RangeError(`${name} must be a non-negative finite number`);
  return resolved;
}
