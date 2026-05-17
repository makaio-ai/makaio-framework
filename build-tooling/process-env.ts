import { existsSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/**
 * Options for {@link createLocalBinPathEnv}.
 */
export interface LocalBinPathEnvOptions {
  /**
   * Directory to start from when locating the nearest workspace binary folder.
   */
  readonly startDir: string;

  /**
   * Base environment to copy before prepending the local binary folder.
   * Defaults to `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Create a child-process environment with the nearest `node_modules/.bin`
 * directory prepended to PATH.
 * @param options - Binary lookup and environment options.
 * @returns Environment object for `child_process` calls.
 */
export function createLocalBinPathEnv(options: LocalBinPathEnvOptions): NodeJS.ProcessEnv {
  const { startDir, env = process.env } = options;
  const binDir = findNearestNodeModulesBin(startDir);
  const existingPath = env['PATH'] ?? env['Path'] ?? '';

  return {
    ...env,
    PATH: [binDir, existingPath].filter(Boolean).join(delimiter),
  };
}

/**
 * Walk upward from a package directory to find the active package manager bin
 * directory for the current source checkout.
 * @param startDir - Directory where the search begins.
 * @returns Absolute path to the nearest `node_modules/.bin` directory.
 */
function findNearestNodeModulesBin(startDir: string): string {
  let current = startDir;

  while (true) {
    const candidate = join(current, 'node_modules', '.bin');
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Cannot find node_modules/.bin while walking up from ${startDir}`);
    }
    current = parent;
  }
}
