/**
 * Compare two strings using stable code-point ordering.
 * @param left - Left-hand string to compare
 * @param right - Right-hand string to compare
 * @returns Negative when `left` sorts before `right`, positive when after, otherwise zero
 */
export function compareCodePointStrings(left: string, right: string): number {
  if (left === right) return 0;

  const leftCodePoints = Array.from(left);
  const rightCodePoints = Array.from(right);
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);

  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftCodePoints[index].codePointAt(0);
    const rightCodePoint = rightCodePoints[index].codePointAt(0);

    if (leftCodePoint !== rightCodePoint) {
      return (leftCodePoint ?? 0) < (rightCodePoint ?? 0) ? -1 : 1;
    }
  }

  return leftCodePoints.length - rightCodePoints.length;
}

/**
 * Compare two strings with a stable case-folded primary order and code-point tie-breaker.
 *
 * This stays local to `contracts` even though `bus-core` has a sibling helper with the same
 * semantics: manifest export must not depend on `bus-core` runtime code just to sort subjects.
 * @param left - Left-hand string to compare
 * @param right - Right-hand string to compare
 * @returns Negative when `left` sorts before `right`, positive when after, otherwise zero
 */
export function compareStrings(left: string, right: string): number {
  const foldedComparison = compareCodePointStrings(left.toLowerCase(), right.toLowerCase());
  if (foldedComparison !== 0) return foldedComparison;

  return compareCodePointStrings(left, right);
}
