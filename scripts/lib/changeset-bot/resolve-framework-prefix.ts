import { execFileSync } from 'node:child_process';
import { resolve, relative } from 'node:path';

/**
 * Resolves the git repository root for a script directory.
 * @param scriptDir - Directory inside the repository.
 * @returns Absolute path to the git repository root.
 */
function resolveGitRoot(scriptDir: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: scriptDir,
    encoding: 'utf-8',
  }).trim();
}

/**
 * Computes the path prefix that must be stripped from repo-root-relative
 * paths to obtain framework-root-relative paths.
 *
 * Derived from a caller-supplied directory (typically `import.meta.dirname`)
 * and its parent relative to the git repository root. Returns the relative
 * directory segment (e.g. `'framework'`) or `''` when the script already lives
 * at the repository root.
 * @param scriptDir - The `__dirname` of the calling script (use `import.meta.dirname`).
 * @param repositoryRoot - Git repository root. Defaults to `git rev-parse --show-toplevel`.
 * @returns Prefix string (without trailing slash), or empty string.
 */
export function resolveFrameworkPrefix(scriptDir: string, repositoryRoot: string = resolveGitRoot(scriptDir)): string {
  const frameworkRoot = resolve(scriptDir, '..');
  const prefix = relative(repositoryRoot, frameworkRoot);
  return prefix === '.' ? '' : prefix;
}
