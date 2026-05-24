/**
 * CLI handler for `makaio git-hooks status`.
 *
 * Reports the native Git hook installation coverage for a repository by
 * reading and verifying the install state file. Outputs a JSON summary of
 * coverage status, reason code, and the list of covered Git operations.
 * @packageDocumentation
 */

import type { CommandContext } from '@makaio/kernel/cli';
import { readGitHookStatus } from '../install/status.js';

/**
 * Parsed CLI argument shape for the `git-hooks status` subcommand.
 */
export interface GitHooksStatusArgs {
  /** Repository root path. Defaults to the current working directory. */
  readonly repo?: string;
}

/**
 * CLI handler for `makaio git-hooks status`.
 *
 * Queries the native hook coverage for the target repository and prints a
 * JSON summary to stdout. Uses the current working directory when `--repo`
 * is omitted.
 * @param ctx - CLI command context.
 */
export async function handleGitHooksStatus(ctx: CommandContext<GitHooksStatusArgs>): Promise<void> {
  const status = await readGitHookStatus(ctx.args.repo ?? process.cwd());

  ctx.output.write(
    `${JSON.stringify(
      {
        covered: status.covered,
        reason: status.reason,
        coveredOperations: status.coveredOperations,
      },
      null,
      2,
    )}\n`,
  );
}
