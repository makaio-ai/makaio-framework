/**
 * Thin wrappers around `git` plumbing commands.
 *
 * All functions spawn a fresh `git` process rather than maintaining any
 * persistent state, keeping the install logic stateless and easy to test.
 * @packageDocumentation
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run a git command and return trimmed stdout.
 *
 * Rejects when the command exits with a non-zero status or produces no output.
 * @param args - Git arguments to execute.
 * @param cwd - Working directory for the git command.
 * @returns Trimmed stdout of the git command.
 */
export async function gitOutput(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd });
  return stdout.trim();
}

/**
 * Run a git command and return trimmed stdout, swallowing failures.
 *
 * Useful for optional configuration queries (e.g. `core.hooksPath`) that may
 * fail when the setting is absent.
 * @param args - Git arguments to execute.
 * @param cwd - Working directory for the git command.
 * @returns Trimmed stdout, or `undefined` when the command fails or returns empty output.
 */
export async function gitOutputOptional(args: readonly string[], cwd: string): Promise<string | undefined> {
  try {
    const output = await gitOutput(args, cwd);
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
