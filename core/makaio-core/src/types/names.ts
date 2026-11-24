/**
 * Names of extensions and of the contributions they declare, and the one
 * ownership rule that ties them together.
 */

import { z } from 'zod';

/**
 * Name of an extension: a plain name (`gateway`, `makaio.clients-core`) or an
 * npm-scoped `@scope/name` (`@acme/review`). Dots are allowed; path separators
 * (`/` outside the scope prefix, `\`) and the dot-segments `.` and `..` are not.
 */
export const ExtensionNameSchema = z
  .string()
  .min(1)
  .regex(/^(@[^/\\]+\/)?[^/\\]+$/, 'Extension name must be a plain identifier or an npm-scoped name (@scope/pkg)')
  .refine((n) => {
    const parts = n.startsWith('@') ? n.split('/') : [n];
    return parts.every((p) => p !== '.' && p !== '..');
  }, 'Extension name must not be a dot-segment');
export type ExtensionName = z.infer<typeof ExtensionNameSchema>;

/**
 * Name of a contribution: `<owner>.<local name>`. The owner is the name of the
 * extension that declares it and may itself contain dots.
 */
export const ContributionNameSchema = z.string().refine(
  (value) => {
    const dot = value.indexOf('.');
    return dot > 0 && !value.endsWith('.');
  },
  { message: 'expected <owner>.<local name>' },
);
// TODO(FACT-383): plain string by decision; a template-literal type is decided together with the name rules
// (zod 4 `refine` does not narrow the inferred type).
export type ContributionName = z.infer<typeof ContributionNameSchema>;

// TODO(FACT-383): an extension named `a` next to one named `a.b` both own `a.b.*`; the rule for that case is
// undecided and pinned by tests.
/**
 * The one ownership rule: an extension contributes only under its own name.
 *
 * Returns the local part when `name` starts with exactly `<owner>.` (owner plus
 * a trailing dot) and the rest is not empty; otherwise `undefined`. An empty
 * owner owns nothing.
 *
 * Owners may contain dots: `makaio.clients-core.profile-changed` belongs to
 * owner `makaio.clients-core`. Npm-scoped owners follow the same exact-prefix
 * rule: `@acme/review.review-posted` belongs to `@acme/review`, not to a
 * prefix-matching variant such as `@acme/rev`.
 * @param owner - Name of the extension that claims the contribution.
 * @param name - Full contribution name.
 * @returns The local name after `<owner>.`, or `undefined` when `owner` does not own `name`.
 */
export function localContributionName(owner: ExtensionName, name: string): string | undefined {
  if (owner.length === 0) {
    return undefined;
  }
  const prefix = `${owner}.`;
  if (!name.startsWith(prefix)) {
    return undefined;
  }
  const local = name.slice(prefix.length);
  return local.length > 0 ? local : undefined;
}

/**
 * Whether a contribution name is canonical and owned by an extension.
 * @param owner - Extension claiming the name.
 * @param name - Full contribution name.
 * @returns Whether the name satisfies both the naming schema and owner prefix.
 */
export function ownsCanonicalContributionName(owner: ExtensionName, name: string): boolean {
  return localContributionName(owner, name) !== undefined && ContributionNameSchema.safeParse(name).success;
}

/**
 * Whether `name` is the extension's own name or a contribution it owns.
 *
 * Combines the identity check with {@link localContributionName}: `true` when
 * `name` equals `owner`, or when `name` is `<owner>.<non-empty rest>`.
 * @param owner - Name of the extension that claims the name.
 * @param name - Candidate name: the extension itself or one of its contributions.
 * @returns `true` when `owner` is `name` or owns it.
 */
export function isOwnNameOrContribution(owner: ExtensionName, name: string): boolean {
  return name === owner || localContributionName(owner, name) !== undefined;
}
