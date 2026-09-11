/**
 * Read an own JSON property without following the prototype chain.
 * @param object - JSON object to inspect.
 * @param key - Property name to read.
 * @returns Own property value, if present.
 */
export function ownValue(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? Reflect.get(object, key) : undefined;
}

/**
 * Define an own property without invoking special prototype setters.
 * @param target - Object receiving the property.
 * @param key - Property name to define.
 * @param value - JSON value to store.
 */
export function defineOwnValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/**
 * Recognize a JSON object as opposed to an array or a primitive.
 * @param value - Candidate value.
 * @returns Whether the value can hold named properties.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Compare two JSON trees by value.
 *
 * Key order is not part of a JSON object's identity, so two objects with the
 * same entries in a different order are equal here.
 * @param left - First value.
 * @param right - Second value.
 * @returns Whether both describe the same JSON value.
 */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonEquals(entry, right[index]));
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && jsonEquals(ownValue(left, key), ownValue(right, key)));
}

/**
 * Follow a property path through a JSON tree.
 * @param value - Value to start from.
 * @param path - Dot-separated property names; an empty path selects the value itself.
 * @returns The value at that path, or undefined when any step is absent.
 */
export function readPropertyPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = ownValue(current, key);
  }
  return current;
}
