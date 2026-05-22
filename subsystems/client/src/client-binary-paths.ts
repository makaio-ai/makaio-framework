import * as path from 'node:path';

/**
 * Determines whether a resolved install path is contained by the configured
 * managed-binary base path.
 *
 * Uses `path.relative()` instead of prefix matching so filesystem roots such as
 * `/` or Windows drive roots still contain their descendants.
 * @param basePath - Absolute configured managed-binary base path
 * @param candidatePath - Stored install path to check before filesystem removal
 * @returns `true` when `candidatePath` is a strict descendant of `basePath`
 */
export function isPathWithinBase(basePath: string, candidatePath: string): boolean {
  const relativePath = path.relative(basePath, candidatePath);
  return (
    relativePath !== '' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== '..' &&
    !path.isAbsolute(relativePath)
  );
}
