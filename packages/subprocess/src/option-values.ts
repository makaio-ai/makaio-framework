/**
 * Validation of the numeric options this package's factories accept.
 * @packageDocumentation
 */

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
  if (!Number.isFinite(resolved) || resolved < 0) throw new RangeError(`${name} must be a non-negative finite number`);
  return resolved;
}
