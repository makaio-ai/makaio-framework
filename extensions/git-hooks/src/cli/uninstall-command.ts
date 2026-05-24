/**
 * CLI handler for `makaio git-hooks uninstall`.
 *
 * Removes Makaio native wrapper scripts from a repository and restores any
 * pre-existing hooks that were backed up at install time. Delegates to
 * {@link uninstallGitHooks}.
 * @packageDocumentation
 */

import type { CommandContext } from '@makaio/kernel/cli';
import { uninstallGitHooks } from '../install/uninstall.js';

/**
 * Parsed CLI argument shape for the `git-hooks uninstall` subcommand.
 */
export interface GitHooksUninstallArgs {
  /** Repository root path. Defaults to the current working directory. */
  readonly repo?: string;
}

/**
 * CLI handler for `makaio git-hooks uninstall`.
 *
 * Removes native Git hook wrapper scripts from the target repository and
 * restores any backed-up pre-existing hooks. Uses the current working
 * directory when `--repo` is omitted.
 * @param ctx - CLI command context.
 */
export async function handleGitHooksUninstall(ctx: CommandContext<GitHooksUninstallArgs>): Promise<void> {
  await uninstallGitHooks({ repoPath: ctx.args.repo ?? process.cwd() });
  ctx.output.write('Removed Makaio Git hooks.\n');
}
