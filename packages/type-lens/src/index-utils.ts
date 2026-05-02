import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { IndexedSymbolRecord } from './index-types.js';

/**
 * Resolve a candidate path against a base path.
 * @param basePath - Absolute base directory.
 * @param candidatePath - Absolute or relative candidate path.
 * @returns Absolute resolved path.
 */
export function resolveInputPath(basePath: string, candidatePath: string): string {
  return path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(basePath, candidatePath);
}

/**
 * Return whether a candidate path is equal to or below a root path.
 * @param rootPath - Root directory path.
 * @param candidatePath - Candidate path to test.
 * @returns True when candidate is inside root or exactly root.
 */
export function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(candidatePath);
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return candidate === root || candidate.startsWith(rootPrefix);
}

/**
 * Clamp an optional numeric value to an inclusive range.
 * @param value - Raw value from the request.
 * @param min - Minimum allowed value (inclusive).
 * @param max - Maximum allowed value (inclusive).
 * @param fallback - Default used when value is absent or NaN.
 * @returns Clamped integer value.
 */
export function clampNumber(value: number | undefined, min: number, max: number, fallback: number): number {
  const clampedFallback = Math.max(min, Math.min(fallback, max));
  const fallbackInteger = Math.trunc(clampedFallback);
  if (typeof value !== 'number' || Number.isNaN(value)) return fallbackInteger;
  return Math.trunc(Math.max(min, Math.min(value, max)));
}

/**
 * Clamp an optional limit to the range [1, 100].
 * @param limit - Raw limit value from the request.
 * @param fallback - Default to use when limit is absent or NaN.
 * @returns Clamped integer limit.
 */
export function clampLimit(limit: number | undefined, fallback: number): number {
  return clampNumber(limit, 1, 100, fallback);
}

/**
 * Check whether a resolved file path should be followed during call resolution.
 *
 * A file is eligible when it lives inside the workspace root (excluding
 * `node_modules`) or when it belongs to an explicitly allowlisted package.
 * @param targetPath - Absolute or relative path of the callee's source file.
 * @param scopePath - Workspace root directory.
 * @param includePackages - Optional package names to follow across the workspace boundary.
 * @returns True when the file should be followed.
 */
export function isEligibleFile(targetPath: string, scopePath: string, includePackages?: string[]): boolean {
  const resolved = path.resolve(targetPath);
  const resolvedScope = path.resolve(scopePath);
  const scopePrefix = resolvedScope.endsWith(path.sep) ? resolvedScope : resolvedScope + path.sep;

  if (
    (resolved === resolvedScope || resolved.startsWith(scopePrefix)) &&
    !resolved.includes(`${path.sep}node_modules${path.sep}`)
  ) {
    return true;
  }

  if (
    includePackages?.some((pkg) => {
      const normalizedPkg = pkg.split('/').join(path.sep);
      const packageRoot = `${path.sep}node_modules${path.sep}${normalizedPkg}${path.sep}`;
      const idx = resolved.indexOf(packageRoot);
      if (idx === -1) return false;
      const suffix = resolved.slice(idx + packageRoot.length);
      const nodeModulesSegment = `node_modules${path.sep}`;
      return !suffix.startsWith(nodeModulesSegment) && !suffix.includes(`${path.sep}${nodeModulesSegment}`);
    })
  ) {
    return true;
  }

  return false;
}

/**
 * Stable sort comparator for symbol records by file then line.
 * @param left - First record.
 * @param right - Second record.
 * @returns Comparison integer for Array.sort.
 */
export function compareRecords(left: IndexedSymbolRecord, right: IndexedSymbolRecord): number {
  const fileDiff = left.absoluteFilePath.localeCompare(right.absoluteFilePath);
  if (fileDiff !== 0) return fileDiff;
  return left.symbol.line - right.symbol.line;
}

/**
 * Return true if the given path exists on the filesystem.
 * @param filePath - Path to check.
 * @returns True if the path is accessible.
 */
export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
