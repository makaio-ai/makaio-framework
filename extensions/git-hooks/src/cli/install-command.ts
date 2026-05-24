/**
 * CLI handler for `makaio git-hooks install`.
 *
 * Installs Makaio native wrapper scripts for the four managed Git hooks in a
 * repository. Delegates to {@link installGitHooks} and reports the hook
 * directory used.
 * @packageDocumentation
 */

import type { CommandContext } from '@makaio/kernel/cli';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGitHooks } from '../install/install.js';

/**
 * Parsed CLI argument shape for the `git-hooks install` subcommand.
 */
export interface GitHooksInstallArgs {
  /** Repository root path. Defaults to the current working directory. */
  readonly repo?: string;
  /**
   * Absolute command used to invoke the receiver binary, written into each
   * wrapper script. Defaults to the current Node executable plus the resolved
   * receiver entrypoint.
   */
  readonly receiverCommand?: string;
}

/**
 * Injectable inputs for resolving and validating receiver commands.
 */
export interface ReceiverCommandResolutionOptions {
  /** URL of this module. Defaults to `import.meta.url`. */
  readonly moduleUrl?: string;
  /** Executable used for the default receiver invocation. */
  readonly nodeExecutable?: string;
}

/**
 * Resolve the default receiver invocation for installed wrapper scripts.
 *
 * Uses the current Node executable plus the receiver entrypoint resolved next to
 * this extension module so Git hooks do not depend on hook-time `PATH` lookup.
 * @param moduleUrl - URL of this module, injectable for tests.
 * @param nodeExecutable - Absolute Node executable path, injectable for tests.
 * @returns Receiver command tokens written into wrapper scripts.
 */
export function resolveDefaultReceiverCommand(
  moduleUrl: string = import.meta.url,
  nodeExecutable: string = process.execPath,
): readonly string[] {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = path.extname(modulePath) || '.mjs';
  return [nodeExecutable, path.resolve(path.dirname(modulePath), '..', 'bin', `git-hook-receiver${extension}`)];
}

/**
 * Resolve and validate the receiver command installed into hook wrappers.
 *
 * Explicit commands must be absolute executable paths. The default command
 * uses the current Node executable plus an absolute receiver entrypoint, and
 * refuses installation if either path cannot be resolved locally.
 * @param args - Parsed install args.
 * @param options - Injectable resolver inputs for tests.
 * @returns Command tokens written into wrapper scripts.
 */
export async function resolveInstallReceiverCommand(
  args: Pick<GitHooksInstallArgs, 'receiverCommand'>,
  options: ReceiverCommandResolutionOptions = {},
): Promise<readonly string[]> {
  if (args.receiverCommand) {
    await assertAbsoluteExecutable(args.receiverCommand, 'receiver command');
    return [args.receiverCommand];
  }

  const [nodeExecutable, receiverEntrypoint] = resolveDefaultReceiverCommand(options.moduleUrl, options.nodeExecutable);
  await assertAbsoluteExecutable(nodeExecutable, 'default receiver command');
  await assertAbsoluteReadable(receiverEntrypoint, 'default receiver entrypoint');
  return [nodeExecutable, receiverEntrypoint];
}

/**
 * CLI handler for `makaio git-hooks install`.
 *
 * Installs native Git hook wrapper scripts in the target repository. Uses the
 * current working directory when `--repo` is omitted, and a resolved absolute
 * receiver command when `--receiver-command` is omitted.
 * @param ctx - CLI command context.
 */
export async function handleGitHooksInstall(ctx: CommandContext<GitHooksInstallArgs>): Promise<void> {
  const receiverCommand = await resolveInstallReceiverCommand(ctx.args);

  const state = await installGitHooks({
    repoPath: ctx.args.repo ?? process.cwd(),
    receiverCommand,
  });

  ctx.output.write(`Installed Git hooks in ${state.hookDir}\n`);
}

/**
 * Assert that a command path is absolute and executable.
 * @param commandPath - Candidate command path.
 * @param label - Human-readable command label for diagnostics.
 */
async function assertAbsoluteExecutable(commandPath: string, label: string): Promise<void> {
  if (!path.isAbsolute(commandPath)) {
    throw new Error(`[git-hooks] ${label} must be an absolute path: ${commandPath}`);
  }

  try {
    await fs.access(commandPath, fsConstants.X_OK);
  } catch {
    throw new Error(`[git-hooks] ${label} must be executable: ${commandPath}`);
  }
}

/**
 * Assert that a file path is absolute and readable.
 * @param filePath - Candidate file path.
 * @param label - Human-readable file label for diagnostics.
 */
async function assertAbsoluteReadable(filePath: string, label: string): Promise<void> {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`[git-hooks] ${label} must be an absolute path: ${filePath}`);
  }

  try {
    await fs.access(filePath, fsConstants.R_OK);
  } catch {
    throw new Error(`[git-hooks] Could not resolve ${label}: ${filePath}`);
  }
}
