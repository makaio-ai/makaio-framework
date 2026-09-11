import { expect } from 'vitest';

/**
 * Structural subset of a Zod safeParse result sufficient for the
 * addressable-parts rejection assertion helper. Using a structural type
 * avoids importing a specific schema's inferred type into shared support.
 *
 * `PropertyKey` (string | number | symbol) matches `$ZodIssueBase.path` in
 * Zod v4, which widened the path element type beyond `string | number`.
 */
type AnyParseResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: { readonly issues: ReadonlyArray<{ readonly path: readonly PropertyKey[] }> };
    };

/**
 * Assert that a safeParse result is a rejection whose issue paths satisfy
 * `predicate`. The default predicate checks that at least one path starts
 * with `'addressableParts.0'`, which covers area-level rejections at index 0.
 *
 * Extracted from the repeated 4-line rejection-assertion block that appeared
 * ~5 times across registration tests (f6).
 * @param result - The safeParse result to assert against.
 * @param predicate - Path predicate; defaults to `startsWith('addressableParts.0')`.
 */
export function expectAddressablePartsIssue(
  result: AnyParseResult,
  predicate: (p: string) => boolean = (p) => p.startsWith('addressableParts.0'),
): void {
  expect(result.success).toBe(false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths.some(predicate)).toBe(true);
  }
}
