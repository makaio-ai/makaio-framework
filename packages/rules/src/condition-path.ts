/**
 * Paths through a condition tree, shared by evaluation errors and check findings.
 *
 * The root path is `''`; keys are joined with `.` and list positions are written as
 * `[index]`, for example `$and[1].$not.$expr` or `$or[0].operator`. Internal to the package.
 */

/**
 * Append a key to a condition-tree path.
 * @param parent - Parent path (root is `''`)
 * @param key - Key of the child
 * @returns The child path
 */
export function childPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

/**
 * Whether a field path is the given path or lies below it. Compares whole segments, so
 * `ab.c` is not below `a`. Field paths split on `.` without escaping, as in evaluation.
 * @param field - Dot-notation field path
 * @param ancestor - Dot-notation path the field may be at or below
 * @returns Whether `field` equals `ancestor` or starts with all of its segments
 */
export function isAtOrBelow(field: string, ancestor: string): boolean {
  return field === ancestor || field.startsWith(`${ancestor}.`);
}
