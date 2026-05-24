/**
 * Git hook uninstallation logic.
 *
 * Reads the install state file, verifies wrapper hashes to detect manual edits,
 * removes wrappers, and restores backed-up pre-existing hooks.
 *
 * All hash checks use the SHA-256 digests recorded at install time to prevent
 * silent corruption if the wrapper has been modified after installation.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GitHookInstallStateSchema, STATE_FILE_NAME, type GitHookStateEntry } from './hook-state.js';
import { sha256 } from './hash.js';
import { assertGitHookStateMatchesTargets, resolveGitHookTargets } from './hook-targets.js';

/**
 * Options for removing native Git hooks installed by Makaio.
 */
export interface UninstallGitHooksOptions {
  /** Path to the repository root or any directory within. */
  readonly repoPath: string;
}

/**
 * Remove Makaio wrapper scripts and restore any backed-up pre-existing hooks.
 *
 * Reads `.git/hooks/.makaio-hooks.json` and verifies the hash of each wrapper
 * before removing it. A hash mismatch indicates the wrapper was manually edited
 * and throws to prevent silent data loss.
 * @param options - Uninstall options including repo path.
 * @throws When any wrapper has been modified since installation, or when the
 *   state file is missing or unparseable.
 */
export async function uninstallGitHooks(options: UninstallGitHooksOptions): Promise<void> {
  const targets = await resolveGitHookTargets(options.repoPath);
  const stateFile = path.join(targets.hookDir, STATE_FILE_NAME);
  const stateText = await fs.readFile(stateFile, 'utf8');
  const state = GitHookInstallStateSchema.parse(JSON.parse(stateText));
  assertGitHookStateMatchesTargets(state, targets);

  const preflight = await Promise.all(
    Object.values(state.hooks)
      .filter((entry): entry is GitHookStateEntry => entry !== undefined)
      .map(preflightEntry),
  );

  for (const check of preflight) {
    await uninstallPreflightedEntry(check.entry);
  }

  await fs.unlink(stateFile).catch(() => {});
}

/**
 * Re-verify one preflighted entry immediately before mutating its files.
 * @param entry - Persisted hook state entry to uninstall.
 */
async function uninstallPreflightedEntry(entry: GitHookStateEntry): Promise<void> {
  const check = await preflightEntry(entry);
  if (check.wrapperExists) {
    await fs.unlink(check.entry.hookPath);
  }

  if (check.restoreBackup) {
    await fs.rename(check.entry.backupPath!, check.entry.hookPath);
  }
}

/** Verified uninstall operations for one persisted hook entry. */
interface UninstallPreflight {
  /** Persisted hook state entry. */
  readonly entry: GitHookStateEntry;
  /** Whether the current wrapper file exists and should be removed. */
  readonly wrapperExists: boolean;
  /** Whether the verified backup should be restored to the hook path. */
  readonly restoreBackup: boolean;
}

/**
 * Verify one persisted hook entry before uninstall mutates any files.
 * @param entry - Persisted hook state entry to verify.
 * @returns The uninstall operations that are safe after all entries preflight.
 */
async function preflightEntry(entry: GitHookStateEntry): Promise<UninstallPreflight> {
  const currentContent = await safeRead(entry.hookPath);
  if (currentContent !== undefined) {
    const currentHash = sha256(currentContent);
    if (currentHash !== entry.wrapperHash) {
      throw new Error(
        `[git-hooks] Refusing to remove modified wrapper at ${entry.hookPath}. ` +
          `Expected hash ${entry.wrapperHash}, found ${currentHash}.`,
      );
    }
  }

  if (!entry.backupPath || !entry.backupHash) {
    return { entry, wrapperExists: currentContent !== undefined, restoreBackup: false };
  }

  const backupContent = await safeRead(entry.backupPath);
  if (backupContent === undefined) {
    throw new Error(`[git-hooks] Refusing to remove wrapper because backup is missing at ${entry.backupPath}.`);
  }

  const backupHash = sha256(backupContent);
  if (backupHash !== entry.backupHash) {
    throw new Error(
      `[git-hooks] Refusing to restore modified backup at ${entry.backupPath}. ` +
        `Expected hash ${entry.backupHash}, found ${backupHash}.`,
    );
  }

  return { entry, wrapperExists: currentContent !== undefined, restoreBackup: true };
}

/**
 * Read a file returning its content, or `undefined` when it does not exist.
 * @param filePath - Absolute path to the file.
 * @returns File content string, or `undefined` on `ENOENT`.
 */
async function safeRead(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
