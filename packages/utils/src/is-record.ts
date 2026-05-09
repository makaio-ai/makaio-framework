/**
 * Check whether a value is a non-array object (a "record").
 * @param value - Value to check.
 * @returns True when the value is a plain record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
