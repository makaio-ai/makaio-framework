import { globby } from 'globby';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ValidateOptions } from '../types.js';

const VALIDATION_FILE_PATTERN = '**/*.{ts,tsx,js,jsx,cjs,mjs,cts,mts,json,jsonc,css,scss}';

/**
 * Patterns that must never be validated, regardless of .gitignore state.
 *
 * Agent-session worktrees under `.claude/worktrees` are full nested checkouts;
 * traversing them multiplies the validated surface by the number of worktrees.
 * They are hard-ignored here because relying on .gitignore alone has proven
 * fragile.
 */
const HARD_IGNORE_PATTERNS = ['**/node_modules/**', '**/.claude/worktrees/**'];

/**
 * Resolves files to validate based on options.
 *
 * Expands directories and glob patterns into a flat list of absolute file paths,
 * automatically ignoring node_modules for performance.
 * @param options - Validation options containing file patterns or glob
 * @returns Promise resolving to list of absolute file paths to validate
 */
export async function resolveFiles(options: ValidateOptions): Promise<string[]> {
  if (options.files) {
    // Process each provided path
    const patterns: string[] = [];

    for (const file of options.files) {
      const absolutePath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);

      try {
        const stats = await fs.stat(absolutePath);

        if (stats.isDirectory()) {
          // Convert directory to glob pattern
          patterns.push(path.join(absolutePath, VALIDATION_FILE_PATTERN));
        } else {
          // Keep files as-is
          patterns.push(absolutePath);
        }
      } catch {
        // If stat fails, treat as a glob pattern or non-existent file
        // Let it be handled by globby or fail later in validation
        patterns.push(absolutePath);
      }
    }

    // Use globby to expand all patterns
    // Only apply the hard ignores for safety - let each tool handle its own ignores
    return globby(patterns, {
      ignore: HARD_IGNORE_PATTERNS,
      absolute: true,
    });
  }

  const pattern = options.glob || VALIDATION_FILE_PATTERN;
  // Respect .gitignore for sensible defaults; keep the hard ignores as fallback
  return globby(pattern, {
    ignore: HARD_IGNORE_PATTERNS,
    gitignore: true,
    absolute: true,
  });
}
