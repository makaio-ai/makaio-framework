import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { MakaioContext } from '@makaio/core';
import { getFileAccessRules } from './file-access-rules.js';

/**
 * Result type for path validation.
 */
export type PathValidationResult = { valid: true } | { valid: false; error: string };

/** Reusable validator for paths resolved within one tool invocation. */
export type PathValidator = (resolvedPath: string) => PathValidationResult;

/**
 * Resolves an existing path, or its nearest existing ancestor, to its canonical path.
 * @param targetPath - Absolute path to canonicalize
 * @returns Canonical absolute path, or undefined when no ancestor can be resolved
 */
function canonicalizePath(targetPath: string): string | undefined {
  let existingPath = path.resolve(targetPath);

  while (true) {
    try {
      const canonicalExistingPath = realpathSync(existingPath);
      return path.resolve(canonicalExistingPath, path.relative(existingPath, targetPath));
    } catch {
      const parentPath = path.dirname(existingPath);
      if (parentPath === existingPath) {
        return undefined;
      }
      existingPath = parentPath;
    }
  }
}

/**
 * Checks whether a canonical target path is contained by a canonical root path.
 * @param rootPath - Canonical allowed root
 * @param targetPath - Canonical target path
 * @returns True when the target is the root or one of its descendants
 */
function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const rootForComparison = process.platform === 'win32' ? rootPath.toLowerCase() : rootPath;
  const targetForComparison = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
  const relativePath = path.relative(rootForComparison, targetForComparison);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
  );
}

/**
 * Resolves a path relative to context.cwd.
 * Handles both absolute and relative paths, normalizing the result.
 * @param inputPath - Path to resolve (absolute or relative)
 * @param context - Makaio execution context
 * @returns Normalized absolute path
 */
export function resolvePath(inputPath: string, context: MakaioContext): string {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath);
  }
  return path.resolve(context.cwd, inputPath);
}

/**
 * Compiles path validation for one tool invocation.
 * Canonical allowed roots are resolved once and reused for every candidate.
 * @param context - Makaio execution context with optional constraints
 * @returns Reusable validation function
 */
export function createPathValidator(context: MakaioContext): PathValidator {
  const rules = getFileAccessRules(context);

  // Prefer allowedDirectories from compiled FileAccessRules; fall back to raw constraints value
  // for backward compatibility when FileAccessRules is not yet injected.
  const legacyAllowed = context.constraints?.allowedDirectories;
  const allowed =
    rules?.allowedDirectories ??
    (Array.isArray(legacyAllowed)
      ? legacyAllowed.filter((value): value is string => typeof value === 'string')
      : undefined);

  const canonicalRoots = allowed?.map(canonicalizePath).filter((root): root is string => root !== undefined);

  return (resolvedPath) => {
    let canonicalPath: string | undefined;

    // Semantics:
    // - undefined: no directory restrictions
    // - []: deny all paths
    // - non-empty: allow-list
    if (allowed !== undefined) {
      if (allowed.length === 0) {
        return {
          valid: false,
          error: `Path '${resolvedPath}' is outside allowed directories`,
        };
      }

      const canonicalCandidate = canonicalizePath(resolvedPath);
      canonicalPath = canonicalCandidate;
      if (
        canonicalCandidate === undefined ||
        canonicalRoots?.some((root) => isWithinRoot(root, canonicalCandidate)) !== true
      ) {
        return {
          valid: false,
          error: `Path '${resolvedPath}' is outside allowed directories`,
        };
      }
    }

    // Evaluate both spellings so neither a symlink alias nor its target can
    // bypass .makaioignore rules.
    if (rules) {
      canonicalPath ??= canonicalizePath(resolvedPath);
      if (
        rules.isDenied(resolvedPath) ||
        (canonicalPath !== undefined && canonicalPath !== resolvedPath && rules.isDenied(canonicalPath))
      ) {
        return {
          valid: false,
          error: `Access denied: '${resolvedPath}' is restricted by .makaioignore rules`,
        };
      }
    }

    return { valid: true };
  };
}

/**
 * Validates that a resolved path is within allowed constraints.
 * Checks against context.constraints.allowedDirectories when provided.
 * @param resolvedPath - Absolute, normalized path to validate
 * @param context - Makaio execution context with optional constraints
 * @returns Validation result indicating if path is allowed
 */
export function validatePath(resolvedPath: string, context: MakaioContext): PathValidationResult {
  return createPathValidator(context)(resolvedPath);
}

/**
 * Resolves and validates a path in one operation.
 * Convenience function that combines resolvePath and validatePath.
 * @param inputPath - Path to resolve and validate
 * @param context - Makaio execution context
 * @param validate - Optional validator compiled by the caller for this invocation
 * @returns Result with resolved path or validation error
 */
export function resolveAndValidatePath(
  inputPath: string,
  context: MakaioContext,
  validate: PathValidator = createPathValidator(context),
): { valid: true; path: string } | { valid: false; error: string } {
  const resolved = resolvePath(inputPath, context);
  const validation = validate(resolved);

  if (!validation.valid) {
    return validation;
  }

  return { valid: true, path: resolved };
}

/**
 * Extracts the file name from a path.
 * @param filePath - Full path to extract name from
 * @returns File or directory name
 */
export function getFileName(filePath: string): string {
  return path.basename(filePath);
}

/**
 * Gets the parent directory of a path.
 * @param filePath - Path to get parent of
 * @returns Parent directory path
 */
export function getParentDir(filePath: string): string {
  return path.dirname(filePath);
}
