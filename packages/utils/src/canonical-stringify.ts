/**
 * Produce a canonical JSON string from a value by recursively sorting object
 * keys. Array element order is preserved since array position is semantically
 * significant.
 *
 * This ensures that `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same
 * string, eliminating insertion-order sensitivity in equality and checksum
 * comparisons.
 *
 * Serialization otherwise mirrors `JSON.stringify`: non-JSON values such as
 * `undefined` or functions are dropped inside objects and mapped to `null`
 * inside arrays. Callers must pass a JSON-serializable value.
 * @param value - The JSON-serializable value to canonicalize.
 * @returns A deterministic JSON string representation.
 * @throws TypeError when the top-level value has no JSON representation.
 */
export function canonicalStringify(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, val: unknown) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      // A null prototype keeps `__proto__` an ordinary JSON key rather than
      // invoking Object.prototype's legacy prototype setter.
      const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const k of Object.keys(val as Record<string, unknown>).sort()) {
        sorted[k] = (val as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return val;
  });

  if (serialized === undefined) {
    throw new TypeError('canonicalStringify requires a top-level JSON-serializable value');
  }

  return serialized;
}
