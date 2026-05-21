/**
 * Convert null values to undefined for specified keys.
 * Used when mapping database rows to API types.
 * @param obj - Source object with nullable fields
 * @param keys - Keys to convert from null to undefined
 * @returns New object with null converted to undefined for specified keys
 * @example
 * ```typescript
 * const dbRow = { id: '1', name: 'test', description: null, value: 42 };
 * const result = nullToUndefined(dbRow, ['description']);
 * // { id: '1', name: 'test', description: undefined, value: 42 }
 * ```
 */
export function nullToUndefined<T extends Record<string, unknown>>(obj: T, keys: (keyof T)[]): T {
  const result = { ...obj };
  for (const key of keys) {
    if (result[key] === null) {
      result[key] = undefined as T[typeof key];
    }
  }
  return result;
}

/**
 * Convert undefined values to null for specified keys.
 * Used when mapping API inputs to database values.
 * @param obj - Source object with optional fields
 * @param keys - Keys to convert from undefined to null
 * @returns New object with undefined converted to null for specified keys
 * @example
 * ```typescript
 * const apiInput = { id: '1', name: 'test', description: undefined, value: 42 };
 * const result = undefinedToNull(apiInput, ['description']);
 * // { id: '1', name: 'test', description: null, value: 42 }
 * ```
 */
export function undefinedToNull<T extends Record<string, unknown>>(obj: T, keys: (keyof T)[]): T {
  const result = { ...obj };
  for (const key of keys) {
    if (result[key] === undefined) {
      result[key] = null as T[typeof key];
    }
  }
  return result;
}
