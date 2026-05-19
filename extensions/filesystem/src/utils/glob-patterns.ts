import * as path from 'node:path';
import type { PathValidationResult } from './path-utils.js';

/**
 * Validates that a glob pattern is scoped to the configured search root.
 * @param pattern - Glob pattern supplied by the tool caller.
 * @returns Validation result indicating whether the pattern stays relative.
 */
export function validateRelativeGlobPattern(pattern: string): PathValidationResult {
  if (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
    return { valid: false, error: 'Absolute glob patterns are not allowed' };
  }

  const parentTraversalToken = /(^|[\\/{}(),])\.\.($|[\\/{}(),])/;
  if (parentTraversalToken.test(pattern)) {
    return { valid: false, error: 'Glob patterns cannot traverse parent directories' };
  }

  return { valid: true };
}
