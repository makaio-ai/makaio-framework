import { isRecord } from '@makaio/utils';

/**
 * Check whether a value is a plain JSON object record.
 * @param value - Value to inspect.
 * @returns `true` for object literals and null-prototype records only.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Applies RFC 7396-style JSON merge patch semantics to account metadata.
 * @param target - Existing metadata object
 * @param patch - Partial metadata patch
 * @returns Merge-patched metadata object
 */
export function applyJsonMergePatch(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = structuredClone(target);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete next[key];
      continue;
    }
    const current = next[key];
    next[key] =
      isPlainRecord(current) && isPlainRecord(value) ? applyJsonMergePatch(current, value) : structuredClone(value);
  }
  return next;
}

/**
 * Returns whether two metadata JSON values are structurally equal.
 * @param left - First value
 * @param right - Second value
 * @returns `true` when the values are semantically identical
 */
export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonValuesEqual(left[key], right[key]))
    );
  }
  return false;
}

/**
 * Returns whether a metadata patch would change the stored JSON document.
 * @param metadata - Existing metadata object
 * @param patch - Partial metadata patch
 * @returns `true` when the merge patch changes the document
 */
export function metadataPatchChanges(metadata: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return !jsonValuesEqual(applyJsonMergePatch(metadata, patch), metadata);
}
