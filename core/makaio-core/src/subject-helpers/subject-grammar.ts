import { splitSubjectKey } from './split-subject-key.js';

/**
 * Checks whether a string is a subject name: a concrete, addressable subject
 * that `splitSubjectKey` can decompose into a namespace and a subject
 * segment, with no wildcard character anywhere in it.
 *
 * This is the grammar `matchesSubscription` treats as an exact-match pattern:
 * a subject name without a trailing `*` only ever matches itself.
 * @param value - Candidate subject string.
 * @returns `true` when `value` names exactly one subject.
 * @example
 * ```typescript
 * isSubjectName('git.worktree'); // true
 * isSubjectName('storage:workflow.list'); // true
 * isSubjectName('github.*'); // false — contains a wildcard
 * isSubjectName('nodot'); // false — splitSubjectKey cannot address it
 * ```
 */
export function isSubjectName(value: string): boolean {
  return splitSubjectKey(value) !== undefined && !value.includes('*');
}

/**
 * Checks whether a string is a subject pattern: a string in the subscription
 * grammar that `matchesSubscription` knows how to evaluate.
 *
 * A value is a subject pattern when it is exactly one of:
 *
 * - `*`, the global wildcard that matches every subject.
 * - A subject name (see `isSubjectName`), which matches only itself.
 * - `<prefix>.*`, a subject wildcard, where `<prefix>` is non-empty, contains
 *   no `*`, and does not end with `.` or `:`.
 * - `<prefix>:*`, a namespace wildcard, where `<prefix>` is non-empty,
 *   contains no `*` and no `.`, and does not end with `:`.
 *
 * Anything else — including a bare namespace with no dot, a pattern with a
 * `*` in the middle, or an empty prefix before `.*`/`:*` — is rejected.
 * @param value - Candidate subject pattern string.
 * @returns `true` when `value` is a pattern `matchesSubscription` can evaluate.
 * @example
 * ```typescript
 * isSubjectPattern('*'); // true — global wildcard
 * isSubjectPattern('git.worktree'); // true — a subject name
 * isSubjectPattern('github.*'); // true — subject wildcard
 * isSubjectPattern('storage:workflow:*'); // true — namespace wildcard
 * isSubjectPattern('nodot'); // false — not addressable and no wildcard suffix
 * isSubjectPattern('.*'); // false — empty prefix
 * isSubjectPattern('a.b:*'); // false — ':*' prefix must not contain '.'
 * ```
 */
export function isSubjectPattern(value: string): boolean {
  if (value === '*') return true;
  if (isSubjectName(value)) return true;

  if (value.endsWith('.*')) {
    const prefix = value.slice(0, -2);
    return prefix.length > 0 && !prefix.includes('*') && !prefix.endsWith('.') && !prefix.endsWith(':');
  }

  if (value.endsWith(':*')) {
    const prefix = value.slice(0, -2);
    return prefix.length > 0 && !prefix.includes('*') && !prefix.includes('.') && !prefix.endsWith(':');
  }

  return false;
}
