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
      isPlainObject(current) && isPlainObject(value) ? applyJsonMergePatch(current, value) : structuredClone(value);
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
  if (isPlainObject(left) && isPlainObject(right)) {
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

/**
 * Returns whether a value is a plain JSON object.
 * @param value - Candidate value to inspect
 * @returns `true` when the value is a non-array object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
