import { satisfies, valid, validRange } from 'semver';
import { z } from 'zod';

/**
 * npm semver range syntax (e.g. `">=1.0.0 <2.0.0"`, `"^1.5.0"`).
 *
 * Used by all range-bearing compatibility fields in descriptors and manifests.
 */
export type VersionRange = string;

/**
 * Exact semver version (e.g. `"1.0.72"`).
 *
 * Used for concrete version pins such as preferred binary versions.
 */
export type VersionLiteral = string;

/** Validates that the string is a valid npm semver range. */
export const VersionRangeSchema = z
  .string()
  .min(1)
  .refine((v) => v.trim().length > 0 && validRange(v) !== null, {
    message: 'Must be a valid semver range (e.g. ">=1.0.0 <2.0.0", "^1.5.0")',
  }) satisfies z.ZodType<VersionRange>;

/**
 * Check whether a concrete version satisfies a semver range.
 *
 * Centralizes the `{ includePrerelease: true }` policy so every compatibility
 * check in the framework uses the same semantics.
 * @param version - Concrete semver version string.
 * @param range - npm semver range to test against.
 * @returns `true` when the version falls within the range.
 */
export function versionSatisfies(version: string, range: VersionRange): boolean {
  return satisfies(version, range, { includePrerelease: true });
}

/**
 * Check whether a semver range is a universal wildcard (`*`, `>=0.0.0`, etc.).
 *
 * Uses the `semver` library's normalization so all universal range syntaxes are
 * recognized, not just the literal `'*'` string.
 * @param range - Semver range to test.
 * @returns `true` when the range matches any version.
 */
export function isUniversalRange(range: string): boolean {
  const normalized = validRange(range);
  return normalized === '*' || normalized === '>=0.0.0' || normalized === '>=0.0.0-0';
}

/** Validates that the string is an exact semver version. */
export const VersionLiteralSchema = z
  .string()
  .min(1)
  .refine((v) => valid(v) !== null && !v.startsWith('v'), {
    message: 'Must be a valid semver version (e.g. "1.0.0")',
  }) satisfies z.ZodType<VersionLiteral>;
