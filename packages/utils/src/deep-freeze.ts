/**
 * Recursively freezes a value so nested objects and arrays become immutable.
 *
 * Exists for the "snapshot once, share forever" pattern: a value that several
 * readers hold at the same time either has to be cloned per reader or has to be
 * unmodifiable. Freezing it deeply once at construction time makes sharing the
 * cheap option without giving any reader the ability to corrupt the others.
 *
 * Cycles are not supported — the intended inputs are validated data snapshots.
 * Non-object values are returned unchanged. Already-frozen containers are still
 * descended into, because `Object.freeze` is shallow and a shallowly frozen
 * object can still hold mutable children.
 * @typeParam TValue - Type of the value being frozen; preserved in the result.
 * @param value - Value to freeze in place.
 * @returns The same value, deeply frozen.
 */
export function deepFreeze<TValue>(value: TValue): TValue {
  if (value !== null && typeof value === 'object') {
    // `Object.values` enumerates array elements as well as object properties, so
    // arrays need no separate branch.
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    return Object.freeze(value);
  }

  return value;
}
