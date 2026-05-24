/**
 * Git hook installation logic.
 *
 * Installs POSIX wrapper scripts for the four managed Git hooks. Each
 * installation:
 * 1. Backs up any pre-existing hook to `<hook>.pre-makaio`.
 * 2. Writes a new wrapper script that chains to the backup then fires the
 *    Makaio receiver.
 * 3. Records all paths and hashes in `.git/hooks/.makaio-hooks.json` for safe
 *    uninstall.
 *
 * All file writes use atomic temp-then-rename to prevent partial-write
 * corruption if the process is interrupted.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomicExclusive } from './atomic-write.js';
import { sha256 } from './hash.js';
import { assertGitHookStateMatchesTargets, resolveGitHookTargets } from './hook-targets.js';
import {
  GitHookInstallStateSchema,
  STATE_FILE_NAME,
  type GitHookInstallState,
  type GitHookName,
  type GitHookStateEntry,
} from './hook-state.js';
import { renderHookWrapper } from './wrapper-template.js';

/**
 * Options for installing native Git hooks.
 */
export interface InstallGitHooksOptions {
  /** Path to the repository root or any directory within. */
  readonly repoPath: string;
  /**
   * Command (with any fixed arguments) used to invoke the receiver binary.
   *
   * Written into each wrapper script and into the state file.
   * Example: `['/usr/local/bin/makaio-git-hook-receiver']`
   */
  readonly receiverCommand: readonly string[];
}

/**
 * Install Makaio wrapper scripts for the four managed Git hooks.
 *
 * Idempotency: re-installing over an already-managed wrapper (identified by
 * the `makaio git-hooks wrapper` comment marker) is a no-op for that hook —
 * no second backup layer is created.
 * @param options - Install options including repo path and receiver command.
 * @returns The install state written to disk.
 */
export async function installGitHooks(options: InstallGitHooksOptions): Promise<GitHookInstallState> {
  const targets = await resolveGitHookTargets(options.repoPath);
  await assertAbsoluteExecutableReceiver(options.receiverCommand);
  await fs.mkdir(targets.hookDir, { recursive: true, mode: 0o755 });

  const stateFile = path.join(targets.hookDir, STATE_FILE_NAME);
  const hooks: Partial<Record<GitHookName, GitHookStateEntry>> = {};
  const existingState = await readExistingInstallState(stateFile, targets);

  for (const target of targets.hooks) {
    let backupPath: string | undefined;
    let backupHash: string | undefined;
    let previousExists = false;

    try {
      const existing = await fs.readFile(target.path, 'utf8');
      previousExists = true;
      if (existing.includes('makaio git-hooks wrapper')) {
        // Preserve the original backup chain so uninstall can still restore.
        const existingEntry = existingState?.hooks[target.name];
        if (existingEntry) {
          backupPath = existingEntry.backupPath;
          backupHash = existingEntry.backupHash;
          previousExists = existingEntry.previousExists;
        } else {
          throw new Error(
            `[git-hooks] Refusing to reinstall managed wrapper without matching state for ${target.path}.`,
          );
        }
      } else {
        backupPath = `${target.path}.pre-makaio`;
        // Guard against an orphaned backup from a previous failed install.
        try {
          await fs.access(backupPath);
          throw new Error(`[git-hooks] Backup already exists at ${backupPath}. Remove it manually or uninstall first.`);
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code !== 'ENOENT') {
            throw error;
          }
        }
        await fs.rename(target.path, backupPath);
        backupHash = sha256(existing);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        throw error;
      }
    }

    const wrapper = renderHookWrapper({
      hookName: target.name,
      stateFile,
      originalHook: backupPath,
      receiverCommand: [...options.receiverCommand],
    });

    await writeFileAtomicExclusive(target.path, wrapper, 0o755);

    hooks[target.name] = {
      hookName: target.name,
      hookPath: target.path,
      wrapperHash: sha256(wrapper),
      backupPath,
      backupHash,
      previousExists,
    };
  }

  const state: GitHookInstallState = {
    version: 1,
    repoRoot: targets.repoRoot,
    hookDir: targets.hookDir,
    receiverCommand: [...options.receiverCommand],
    installedAt: new Date().toISOString(),
    hooks,
  };

  await writeFileAtomicExclusive(stateFile, JSON.stringify(state, null, 2));

  return state;
}

/**
 * Ensure the receiver command persists an absolute executable path.
 * @param receiverCommand - Receiver command and fixed arguments passed to wrappers.
 */
async function assertAbsoluteExecutableReceiver(receiverCommand: readonly string[]): Promise<void> {
  const executable = receiverCommand[0];
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error('[git-hooks] Receiver command must start with an absolute executable path.');
  }

  try {
    const stat = await fs.stat(executable);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) {
      throw new Error('[git-hooks] Receiver command must start with an absolute executable path.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('[git-hooks] Receiver command must start with an absolute executable path.');
    }
    throw error;
  }
}

/**
 * Load and validate existing state so reinstall preserves the backup chain.
 * @param stateFile - Active install state file path.
 * @param targets - Freshly resolved hook targets for the current repository.
 * @returns Existing state, or `undefined` when no state file exists.
 */
async function readExistingInstallState(
  stateFile: string,
  targets: Awaited<ReturnType<typeof resolveGitHookTargets>>,
): Promise<GitHookInstallState | undefined> {
  try {
    const existingStateText = await fs.readFile(stateFile, 'utf8');
    const existingState = GitHookInstallStateSchema.parse(JSON.parse(existingStateText));
    assertGitHookStateMatchesTargets(existingState, targets);
    return existingState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
