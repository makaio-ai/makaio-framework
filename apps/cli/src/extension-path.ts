import * as path from 'node:path';

/**
 * Build a portable relative import path between two absolute filesystem paths.
 * @param fromDir - Directory the import originates from.
 * @param targetPath - Absolute file or directory path to reach.
 * @returns Relative import path with POSIX separators.
 */
export function toRelativeImportPath(fromDir: string, targetPath: string): string {
  const relativeTarget = toPortableRelativePath(path.relative(fromDir, targetPath));
  return relativeTarget.startsWith('./') || relativeTarget.startsWith('../') ? relativeTarget : `./${relativeTarget}`;
}

/**
 * Normalize a relative path to POSIX separators for generated files.
 * @param value - Raw path value.
 * @returns Portable relative path string.
 */
export function toPortableRelativePath(value: string): string {
  return value.replaceAll(path.sep, '/');
}
