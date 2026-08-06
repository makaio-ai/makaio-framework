/** The two segments a full bus subject key decomposes into. */
export interface SubjectKeySegments {
  /**
   * Namespace part of the key.
   *
   * Everything before the **first** dot, colons included: `:` is a namespace
   * *hierarchy* boundary, not a namespace/subject separator, so
   * `storage:workflow.list` has namespace `storage:workflow`.
   */
  readonly namespace: string;
  /** Subject part of the key: everything after the first dot. */
  readonly subject: string;
}

/**
 * Splits a full bus subject key into its namespace and subject segments.
 *
 * A full subject key is always `<namespace>.<subject>` with both segments
 * non-empty. `.event`, `event.`, and a key with no dot at all are all equally
 * unaddressable — none of them names a namespace-and-subject pair any emitter can
 * produce — so all three are rejected rather than reported as a partial split.
 *
 * Returning `undefined` instead of throwing keeps the decision at the call site:
 * a subject *pattern* being validated wants a domain error naming the pattern,
 * while a subject the framework itself constructed wants an assertion. Neither
 * wants this helper's phrasing.
 * @param key - Full bus subject key or namespace-level wildcard pattern.
 * @returns The two segments, or `undefined` when `key` is not a full subject key.
 * @example
 * ```typescript
 * splitSubjectKey('git.worktree'); // { namespace: 'git', subject: 'worktree' }
 * splitSubjectKey('storage:workflow.list'); // { namespace: 'storage:workflow', subject: 'list' }
 * splitSubjectKey('github.*'); // { namespace: 'github', subject: '*' }
 * splitSubjectKey('nodot'); // undefined
 * ```
 */
export function splitSubjectKey(key: string): SubjectKeySegments | undefined {
  const separator = key.indexOf('.');
  if (separator <= 0 || separator === key.length - 1) return undefined;

  return { namespace: key.slice(0, separator), subject: key.slice(separator + 1) };
}
