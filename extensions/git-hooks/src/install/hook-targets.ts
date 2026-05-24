/**
 * Git hook path resolution via `git` plumbing commands.
 *
 * All paths are resolved through the git binary rather than inferred from
 * filesystem conventions, ensuring correctness for worktrees, `GIT_DIR`
 * overrides, and `core.hooksPath` configurations.
 * @packageDocumentation
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gitOutput, gitOutputOptional } from './git-command.js';
import { GIT_HOOK_NAMES, type GitHookInstallState, type GitHookName, type GitHookStateEntry } from './hook-state.js';

/**
 * A single resolved native hook target.
 */
export interface GitHookTarget {
  /** Native hook name. */
  readonly name: GitHookName;
  /** Absolute path to the hook file (may not exist yet). */
  readonly path: string;
}

/**
 * Fully resolved hook installation targets for a repository.
 */
export interface GitHookTargets {
  /** Absolute repository root (output of `git rev-parse --show-toplevel`). */
  readonly repoRoot: string;
  /** Absolute path to the git common dir (output of `git rev-parse --git-common-dir`). */
  readonly gitCommonDir: string;
  /** Absolute path to the hooks directory derived from `hooks[0].path`. */
  readonly hookDir: string;
  /** Whether the repository is bare. */
  readonly isBare: boolean;
  /**
   * Value of `core.hooksPath` when set, otherwise `undefined`.
   *
   * Used to detect explicit `/dev/null` redirects and custom hook locations.
   */
  readonly hooksPath: string | undefined;
  /** Resolved target for each of the four managed hook names. */
  readonly hooks: readonly GitHookTarget[];
}

/**
 * Resolve native hook installation targets for a repository using git plumbing.
 *
 * Uses `git rev-parse --git-path hooks/<name>` for each hook so that
 * `core.hooksPath`, worktree layouts, and `GIT_DIR` overrides are all handled
 * transparently by git itself.
 * @param repoPath - Path to the repository root or a directory within.
 * @returns Resolved hook targets for the repository.
 * @throws When the repository is bare, hooks are redirected to `/dev/null`,
 *   or any resolved hook path is a symlink.
 */
export async function resolveGitHookTargets(repoPath: string): Promise<GitHookTargets> {
  const repoRoot = await gitOutput(['rev-parse', '--show-toplevel'], repoPath);
  const isBare = (await gitOutput(['rev-parse', '--is-bare-repository'], repoRoot)) === 'true';
  if (isBare) {
    throw new Error(`[git-hooks] Refusing to install hooks into bare repository: ${repoRoot}`);
  }

  const gitCommonDirRaw = await gitOutput(['rev-parse', '--git-common-dir'], repoRoot);
  const gitCommonDir = path.resolve(repoRoot, gitCommonDirRaw);
  const hooksPath = await gitOutputOptional(['config', '--path', '--get', 'core.hooksPath'], repoRoot);

  const hooks = await Promise.all(
    GIT_HOOK_NAMES.map(async (name) => {
      const hookPathRaw = await gitOutput(['rev-parse', '--git-path', `hooks/${name}`], repoRoot);
      const hookPath = path.resolve(repoRoot, hookPathRaw);
      return { name, path: hookPath };
    }),
  );

  const firstHook = hooks[0];
  if (!firstHook) {
    throw new Error('[git-hooks] No hook names to resolve — GIT_HOOK_NAMES is empty.');
  }

  const hookDir = path.dirname(firstHook.path);
  if (hookDir === '/dev/null' || hooks.some((hook) => hook.path.startsWith('/dev/null/'))) {
    throw new Error('[git-hooks] Refusing to install because core.hooksPath disables hooks with /dev/null.');
  }

  await assertNoSymlinkInHookTargets(hooks);
  return { repoRoot, gitCommonDir, hookDir, isBare, hooksPath, hooks };
}

/**
 * Validate persisted hook state against the repository's current Git hook
 * targets before trusting any path from disk.
 * @param state - Parsed persisted install state.
 * @param targets - Freshly resolved Git hook targets.
 */
export function assertGitHookStateMatchesTargets(state: GitHookInstallState, targets: GitHookTargets): void {
  if (normalizePath(state.repoRoot) !== normalizePath(targets.repoRoot)) {
    throw new Error(
      `[git-hooks] Install state repo root ${state.repoRoot} does not match current repository ${targets.repoRoot}.`,
    );
  }
  if (normalizePath(state.hookDir) !== normalizePath(targets.hookDir)) {
    throw new Error(
      `[git-hooks] Install state hook directory ${state.hookDir} does not match current hook directory ${targets.hookDir}.`,
    );
  }

  const targetsByName = new Map(targets.hooks.map((target) => [target.name, target.path] as const));
  for (const hookName of GIT_HOOK_NAMES) {
    const entry = state.hooks[hookName];
    if (!entry) continue;
    assertEntryMatchesTarget(hookName, entry, targetsByName.get(hookName));
  }
}

/**
 * Validate one persisted hook entry against its currently resolved target path.
 * @param hookName - Hook name from the state object key.
 * @param entry - Persisted state entry to validate.
 * @param targetPath - Current hook target path for the hook name.
 */
function assertEntryMatchesTarget(
  hookName: GitHookName,
  entry: GitHookStateEntry,
  targetPath: string | undefined,
): void {
  if (!targetPath) {
    throw new Error(`[git-hooks] No current Git hook target exists for ${hookName}.`);
  }
  if (entry.hookName !== hookName) {
    throw new Error(`[git-hooks] State entry ${hookName} records mismatched hook name ${entry.hookName}.`);
  }
  if (normalizePath(entry.hookPath) !== normalizePath(targetPath)) {
    throw new Error(`[git-hooks] State entry for ${hookName} does not match current Git hook target ${targetPath}.`);
  }

  const hasBackupPath = entry.backupPath !== undefined;
  const hasBackupHash = entry.backupHash !== undefined;
  if (hasBackupPath !== hasBackupHash) {
    throw new Error(`[git-hooks] State entry for ${hookName} has incomplete backup metadata.`);
  }
  if (entry.previousExists && (!entry.backupPath || !entry.backupHash)) {
    throw new Error(`[git-hooks] State entry for ${hookName} is missing backup metadata.`);
  }
  if (!entry.previousExists && (entry.backupPath || entry.backupHash)) {
    throw new Error(`[git-hooks] State entry for ${hookName} has unexpected backup metadata.`);
  }
  if (entry.backupPath && normalizePath(entry.backupPath) !== normalizePath(`${targetPath}.pre-makaio`)) {
    throw new Error(
      `[git-hooks] State entry for ${hookName} backup path ${entry.backupPath} does not match current Git hook target.`,
    );
  }
}

/**
 * Normalize a filesystem path for equality checks without resolving symlinks.
 * @param filePath - Filesystem path to normalize.
 * @returns Absolute normalized path.
 */
function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

/**
 * Guard against symlinked hook files.
 *
 * Overwriting a symlink would silently corrupt the link target, so we
 * treat any symlinked existing hook as a fatal error.
 * @param hooks - Hook targets to inspect.
 * @throws When any hook path resolves to a symbolic link.
 */
async function assertNoSymlinkInHookTargets(hooks: readonly GitHookTarget[]): Promise<void> {
  for (const hook of hooks) {
    try {
      const stat = await fs.lstat(hook.path);
      if (stat.isSymbolicLink()) {
        throw new Error(`[git-hooks] Refusing to overwrite symlink hook target: ${hook.path}`);
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
}
