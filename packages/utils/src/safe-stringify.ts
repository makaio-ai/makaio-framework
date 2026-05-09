/**
 * JSON-stringify a value, handling BigInt and circular references gracefully.
 * @param value - Value to serialize.
 * @returns JSON string, never throws.
 */
export function safeStringify(value: unknown): string {
  if (value === undefined) return 'null';
  const stack: object[] = [];
  try {
    const json = JSON.stringify(value, function (this: object, _key, v: unknown) {
      if (typeof v === 'bigint') return v.toString();
      while (stack.length > 0 && stack[stack.length - 1] !== this) {
        stack.pop();
      }
      if (typeof v === 'object' && v !== null) {
        if (stack.includes(v)) return '[Circular]';
        stack.push(v);
      }
      return v;
    });
    return json ?? JSON.stringify(String(value)) ?? '"[Unserializable]"';
  } catch {
    try {
      return JSON.stringify(String(value)) ?? '"[Unserializable]"';
    } catch {
      return '"[Unserializable]"';
    }
  }
}
