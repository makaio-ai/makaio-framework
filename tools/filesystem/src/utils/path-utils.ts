import * as path from 'node:path';
import type { MakaioContext } from '@makaio/core';
import { getFileAccessRules } from './file-access-rules.js';

/**
 * Result type for path validation.
 */
export type PathValidationResult = { valid: true } | { valid: false; error: string };

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
 * Validates that a resolved path is within allowed constraints.
 * Checks against context.constraints.allowedDirectories when provided.
 * @param resolvedPath - Absolute, normalized path to validate
 * @param context - Makaio execution context with optional constraints
 * @returns Validation result indicating if path is allowed
 */
export function validatePath(resolvedPath: string, context: MakaioContext): PathValidationResult {
  const rules = getFileAccessRules(context);

  // Prefer allowedDirectories from compiled FileAccessRules; fall back to raw constraints value
  // for backward compatibility when FileAccessRules is not yet injected.
  const legacyAllowed = context.constraints?.allowedDirectories;
  const allowed =
    rules?.allowedDirectories ??
    (Array.isArray(legacyAllowed)
      ? legacyAllowed.filter((value): value is string => typeof value === 'string')
      : undefined);

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

    const normalizedPath = path.normalize(resolvedPath);
    const isAllowed = allowed.some((dir) => {
      const normalizedDir = path.normalize(dir);
      // Check if path starts with allowed directory (with proper path separator)
      return normalizedPath === normalizedDir || normalizedPath.startsWith(normalizedDir + path.sep);
    });

    if (!isAllowed) {
      return {
        valid: false,
        error: `Path '${resolvedPath}' is outside allowed directories`,
      };
    }
  }

  // Deny paths matched by .makaioignore rules when rules are present
  if (rules && rules.isDenied(resolvedPath)) {
    return {
      valid: false,
      error: `Access denied: '${resolvedPath}' is restricted by .makaioignore rules`,
    };
  }

  return { valid: true };
}

/**
 * Resolves and validates a path in one operation.
 * Convenience function that combines resolvePath and validatePath.
 * @param inputPath - Path to resolve and validate
 * @param context - Makaio execution context
 * @returns Result with resolved path or validation error
 */
export function resolveAndValidatePath(
  inputPath: string,
  context: MakaioContext,
): { valid: true; path: string } | { valid: false; error: string } {
  const resolved = resolvePath(inputPath, context);
  const validation = validatePath(resolved, context);

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
