/**
 * Safely serialize a value to JSON string.
 *
 * Handles BigInt values, circular references, and non-serializable types
 * without throwing. Circular nodes are replaced with `'[Circular]'` rather
 * than aborting the entire serialization. Falls back to `String(value)` when
 * JSON serialization is not possible at all.
 * @param value - The value to serialize
 * @returns JSON string representation or a fallback string on failure
 */
export function safeJsonStringify(value: unknown): string {
  const ancestors: object[] = [];
  try {
    return (
      JSON.stringify(
        value,
        function (this: unknown, _key: string, v: unknown) {
          if (typeof v === 'bigint') return v.toString();
          if (typeof v === 'object' && v !== null) {
            while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
              ancestors.pop();
            }
            if (ancestors.includes(v)) return '[Circular]';
            ancestors.push(v);
          }
          return v;
        },
        2,
      ) ?? '[Non-serializable value]'
    );
  } catch {
    try {
      return String(value);
    } catch {
      return '[Non-serializable value]';
    }
  }
}
