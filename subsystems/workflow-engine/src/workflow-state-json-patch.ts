import type { JsonPatchOperation, JsonValue } from '@makaio/contracts';

/**
 * Build JSON Patch operations that transform one JSON value into another.
 * @param before - Current persisted state value.
 * @param after - Mutated state value.
 * @returns JSON Patch operations for audit logging and state update events.
 */
export function createWorkflowStatePatch(before: JsonValue, after: JsonValue): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  appendJsonPatchOperations(operations, '', before, after);
  return operations;
}

/**
 * Append JSON Patch operations for a pair of values at a specific pointer path.
 * @param operations - Mutable operation accumulator.
 * @param path - JSON Pointer path for the compared values.
 * @param before - Current value at the pointer path.
 * @param after - Mutated value at the pointer path.
 */
function appendJsonPatchOperations(
  operations: JsonPatchOperation[],
  path: string,
  before: JsonValue,
  after: JsonValue,
): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    appendArrayPatchOperations(operations, path, before, after);
    return;
  }

  if (isJsonObject(before) && isJsonObject(after)) {
    appendObjectPatchOperations(operations, path, before, after);
    return;
  }

  if (!jsonValuesEqual(before, after)) {
    operations.push({ op: 'replace', path, value: after });
  }
}

/**
 * Append JSON Patch operations for object keys at a specific pointer path.
 * @param operations - Mutable operation accumulator.
 * @param path - JSON Pointer path for the compared object.
 * @param before - Current object value.
 * @param after - Mutated object value.
 */
function appendObjectPatchOperations(
  operations: JsonPatchOperation[],
  path: string,
  before: Record<string, JsonValue>,
  after: Record<string, JsonValue>,
): void {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();

  for (const key of keys) {
    const beforeHasKey = hasOwnJsonProperty(before, key);
    const afterHasKey = hasOwnJsonProperty(after, key);
    const childPath = `${path}/${escapeJsonPointerSegment(key)}`;

    if (!beforeHasKey && afterHasKey) {
      operations.push({ op: 'add', path: childPath, value: after[key] as JsonValue });
      continue;
    }

    if (beforeHasKey && !afterHasKey) {
      operations.push({ op: 'remove', path: childPath });
      continue;
    }

    appendJsonPatchOperations(operations, childPath, before[key] as JsonValue, after[key] as JsonValue);
  }
}

/**
 * Append JSON Patch operations for array entries at a specific pointer path.
 * @param operations - Mutable operation accumulator.
 * @param path - JSON Pointer path for the compared array.
 * @param before - Current array value.
 * @param after - Mutated array value.
 */
function appendArrayPatchOperations(
  operations: JsonPatchOperation[],
  path: string,
  before: JsonValue[],
  after: JsonValue[],
): void {
  const sharedLength = Math.min(before.length, after.length);
  for (let index = 0; index < sharedLength; index++) {
    appendJsonPatchOperations(
      operations,
      `${path}/${String(index)}`,
      before[index] as JsonValue,
      after[index] as JsonValue,
    );
  }

  for (let index = before.length - 1; index >= after.length; index--) {
    operations.push({ op: 'remove', path: `${path}/${String(index)}` });
  }

  for (let index = before.length; index < after.length; index++) {
    operations.push({ op: 'add', path: `${path}/${String(index)}`, value: after[index] as JsonValue });
  }
}

/**
 * Check whether a JSON value is a non-array object.
 * @param value - JSON value to inspect.
 * @returns `true` when the value is a JSON object.
 */
function isJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check whether a JSON object owns a key directly.
 * @param value - JSON object to inspect.
 * @param key - Property name to check.
 * @returns `true` when the key is an own property.
 */
function hasOwnJsonProperty(value: Record<string, JsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Escape a JSON Pointer segment.
 * @param segment - Raw pointer segment.
 * @returns Escaped JSON Pointer segment.
 */
function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll('~', '~0').replaceAll('/', '~1');
}

/**
 * Compare two JSON values at the current pointer path.
 * @param left - First value.
 * @param right - Second value.
 * @returns `true` when the values are equal.
 */
function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  return Object.is(left, right);
}
