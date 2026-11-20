/**
 * Thin wrappers around `git` plumbing commands.
 *
 * All functions spawn a fresh `git` process rather than maintaining any
 * persistent state, keeping the install logic stateless and easy to test.
 * @packageDocumentation
 */

import { launch as realLaunch, launchForOutput, type LaunchFunction } from '@makaio/subprocess';

/** Longest time a single git plumbing command may run. */
const GIT_TIMEOUT_MS = 30_000;
/** Largest combined stdout and stderr, in bytes, kept from a git command. */
const GIT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Run a git command and return trimmed stdout.
 *
 * Rejects when the command does not complete (non-zero exit, timeout, stop or start failure).
 * @param args - Git arguments to execute.
 * @param cwd - Working directory for the git command.
 * @param launch - Starts the process; defaults to the real `launch`.
 * @returns Trimmed stdout of the git command.
 */
export async function gitOutput(
  args: readonly string[],
  cwd: string,
  launch: LaunchFunction = realLaunch,
): Promise<string> {
  const outcome = await launchForOutput(
    {
      command: 'git',
      args,
      cwd,
      envMode: 'merge',
      timeoutMs: GIT_TIMEOUT_MS,
      outputLimitBytes: GIT_OUTPUT_LIMIT_BYTES,
    },
    launch,
  );
  if (!outcome.ok) {
    // Fixed text: the arguments and the command's output stay out of the error.
    throw new Error(`git command ended with status ${outcome.result.status}`);
  }
  return outcome.stdout.trim();
}

/**
 * Run a git command and return trimmed stdout, swallowing failures.
 *
 * Useful for optional configuration queries (e.g. `core.hooksPath`) that may
 * fail when the setting is absent.
 * @param args - Git arguments to execute.
 * @param cwd - Working directory for the git command.
 * @param launch - Starts the process; defaults to the real `launch`.
 * @returns Trimmed stdout, or `undefined` when the command fails or returns empty output.
 */
export async function gitOutputOptional(
  args: readonly string[],
  cwd: string,
  launch: LaunchFunction = realLaunch,
): Promise<string | undefined> {
  try {
    const output = await gitOutput(args, cwd, launch);
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}
