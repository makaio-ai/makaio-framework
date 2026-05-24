import { exec } from 'child_process';
import * as fs from 'node:fs/promises';
import path from 'path';
import { promisify } from 'util';
import type { IMakaioBus } from '@makaio/bus-core';
import { GitHookSubjects, type GitHookCoveredOperation } from '@makaio/contracts';
import { GitSubjects } from './namespace.js';
import type {
  GitCommitEvent,
  GitCheckoutEvent,
  GitStagingEvent,
  GitMergeEvent,
  GitRebaseEvent,
  GitWorktreeEvent,
  GitAddRepoResponse,
  GitRemoveRepoResponse,
} from './schemas.js';
import { FsSubjects } from '@makaio/services-core/filesystem';
import type { FsChanged } from '@makaio/services-core/filesystem/schemas';

/**
 * Per-repo watcher state.
 */
interface RepoWatcher {
  /** Absolute path to repo root */
  repoRoot: string;
  /** Absolute path to git metadata directory that is being watched */
  gitDir: string;
  /** Unique watch ID for FileWatcher */
  watchId: string;
}

const execAsync = promisify(exec);

/** Types of git operations that can be detected from .git file changes. */
export type GitOperationType = 'commit' | 'checkout' | 'staging' | 'merge' | 'rebase';

/** Result of interpreting a file change as a git operation. */
export type InterpretResult = {
  type: GitOperationType | 'worktree-added' | 'worktree-removed';
  worktree: string | undefined;
} | null;

interface FileChange {
  path: string;
  kind: 'create' | 'change' | 'delete';
}

/**
 * Execute a git command and return trimmed stdout.
 * @param cmd - The git command to execute (without 'git' prefix).
 * @param cwd - The working directory to execute the command in.
 * @returns The trimmed stdout from the command.
 */
async function git(cmd: string, cwd: string): Promise<string> {
  const { stdout } = await execAsync(`git ${cmd}`, { cwd });
  return stdout.trim();
}

/**
 * Interpret a file change relative to a repo's .git directory.
 * @param gitDir - The .git directory path.
 * @param change - The file change event.
 * @returns Interpretation result or null if unrecognized.
 */
function interpretChangeForRepo(gitDir: string, change: FileChange): InterpretResult {
  const relativePath = change.path.slice(gitDir.length + 1);
  const worktreeMatch = relativePath.match(/^worktrees\/([^/]+)(?:\/(.*))?$/);
  if (worktreeMatch) {
    const [, name, subPath] = worktreeMatch;
    return interpretWorktreePath(name, subPath, change.kind);
  }
  return interpretMainRepoPath(relativePath);
}

/**
 * Interpret a path within a worktree's .git/worktrees/name/ directory.
 * @param name - The worktree name.
 * @param subPath - The path within the worktree directory.
 * @param kind - The type of file change.
 * @returns Interpretation result or null if unrecognized.
 */
function interpretWorktreePath(
  name: string,
  subPath: string | undefined,
  kind: 'create' | 'change' | 'delete',
): InterpretResult {
  if (!subPath) {
    if (kind === 'create') return { type: 'worktree-added', worktree: name };
    if (kind === 'delete') return { type: 'worktree-removed', worktree: name };
    return null;
  }
  if (subPath === 'gitdir') {
    if (kind === 'create') return { type: 'worktree-added', worktree: name };
    if (kind === 'delete') return { type: 'worktree-removed', worktree: name };
  }
  if (subPath === 'HEAD') return { type: 'checkout', worktree: name };
  if (subPath === 'index') return { type: 'staging', worktree: name };
  if (subPath === 'MERGE_HEAD' || subPath === 'CHERRY_PICK_HEAD') return { type: 'merge', worktree: name };
  if (subPath === 'REBASE_HEAD' || subPath.startsWith('rebase-merge/')) return { type: 'rebase', worktree: name };
  return null;
}

/**
 * Interpret a path in the main repo's .git/ directory.
 * @param path - The relative path within the .git directory.
 * @returns Interpretation result or null if unrecognized.
 */
function interpretMainRepoPath(path: string): InterpretResult {
  if (path.startsWith('refs/heads/')) return { type: 'commit', worktree: undefined };
  if (path === 'HEAD') return { type: 'checkout', worktree: undefined };
  if (path === 'index') return { type: 'staging', worktree: undefined };
  if (path === 'MERGE_HEAD' || path === 'CHERRY_PICK_HEAD') return { type: 'merge', worktree: undefined };
  if (path === 'REBASE_HEAD' || path.startsWith('rebase-merge/')) return { type: 'rebase', worktree: undefined };
  return null;
}

/**
 * GitWatcher observes .git/ directory changes and emits semantic git events.
 * Supports watching multiple repositories simultaneously.
 *
 * This is an internal component used by GitService.
 */
export class GitWatcher {
  private readonly bus: IMakaioBus;
  private readonly watchers = new Map<string, RepoWatcher>();
  private unsubFsChanged: (() => void) | null = null;
  private unsubAddRepo: (() => void) | null = null;
  private unsubRemoveRepo: (() => void) | null = null;
  private initialized = false;

  public constructor(bus: IMakaioBus) {
    this.bus = bus;
  }

  /** Initialize the watcher and register bus handlers. */
  public async init(): Promise<void> {
    if (this.initialized) return;

    this.unsubAddRepo = this.bus.on(GitSubjects.addRepo, async (ctx) => {
      const result = await this.addRepo(ctx.payload.repoPath);
      ctx.setResult(result);
    });

    this.unsubRemoveRepo = this.bus.on(GitSubjects.removeRepo, async (ctx) => {
      const result = await this.removeRepo(ctx.payload.repoPath);
      ctx.setResult(result);
    });

    this.unsubFsChanged = this.bus.on(FsSubjects.changed, async (ctx) => {
      await this.handleFsChange(ctx.payload);
    });

    this.initialized = true;
  }

  /** Destroy the watcher and cleanup all watchers. */
  public async destroy(): Promise<void> {
    this.unsubFsChanged?.();
    this.unsubAddRepo?.();
    this.unsubRemoveRepo?.();
    this.unsubFsChanged = null;
    this.unsubAddRepo = null;
    this.unsubRemoveRepo = null;

    const repoPaths = [...this.watchers.keys()];
    await Promise.all(repoPaths.map((repoPath) => this.removeRepo(repoPath)));
    this.initialized = false;
  }

  /**
   * Add a repository to watch.
   * @param repoPath - Absolute path to the repository root.
   * @returns Response indicating success or failure.
   */
  private async addRepo(repoPath: string): Promise<GitAddRepoResponse> {
    if (this.watchers.has(repoPath)) {
      return { success: true };
    }

    const watchId = `git-watcher-${repoPath}`;

    try {
      const gitDir = await this.resolveGitDir(repoPath);
      // Exclude .git from default ignores so we can watch it
      await this.bus.request(FsSubjects.watch, {
        id: watchId,
        paths: [gitDir],
        excludeFromDefaults: ['**/.git/**'],
      });
      this.watchers.set(repoPath, { repoRoot: repoPath, gitDir, watchId });
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Resolve the directory that should be watched for git metadata changes.
   *
   * For standard repos, `.git` is a directory and is returned directly.
   * For worktree checkouts, `.git` is a file containing `gitdir: <path>`.
   * In that case we resolve and return the referenced git directory.
   * @param repoPath - Absolute path to repository/worktree root
   * @returns Absolute path to git metadata directory
   */
  private async resolveGitDir(repoPath: string): Promise<string> {
    const dotGitPath = path.join(repoPath, '.git');
    let dotGitStats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      dotGitStats = await fs.stat(dotGitPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        throw new Error(`Not a git repository: no .git found at ${repoPath}`);
      }
      throw error;
    }
    if (dotGitStats.isDirectory()) {
      return dotGitPath;
    }
    if (!dotGitStats.isFile()) {
      throw new Error(`Unsupported .git entry at ${dotGitPath} (expected file or directory).`);
    }

    const gitFileContent = await fs.readFile(dotGitPath, 'utf8');
    const line = gitFileContent.trim();
    const prefix = 'gitdir:';
    if (!line.toLowerCase().startsWith(prefix)) {
      throw new Error(`Invalid .git file format at ${dotGitPath}.`);
    }

    const gitDirReference = line.slice(prefix.length).trim();
    if (gitDirReference.length === 0) {
      throw new Error(`Empty gitdir reference in ${dotGitPath}.`);
    }

    const resolvedGitDir = path.resolve(path.dirname(dotGitPath), gitDirReference);
    let resolvedStats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      resolvedStats = await fs.stat(resolvedGitDir);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === 'ENOENT') {
        throw new Error(`Invalid .git gitdir reference at ${dotGitPath}: path does not exist (${resolvedGitDir}).`);
      }
      throw error;
    }
    if (!resolvedStats.isDirectory()) {
      throw new Error(`Invalid .git gitdir reference at ${dotGitPath}: expected directory, found ${resolvedGitDir}.`);
    }
    return resolvedGitDir;
  }

  /**
   * Remove a repository from watching.
   * @param repoPath - Absolute path to the repository root.
   * @returns Response indicating success or failure.
   */
  private async removeRepo(repoPath: string): Promise<GitRemoveRepoResponse> {
    const watcher = this.watchers.get(repoPath);
    if (!watcher) {
      return { success: true };
    }

    try {
      await this.bus.request(FsSubjects.unwatch, { id: watcher.watchId });
    } catch {
      // Ignore unwatch errors
    }

    this.watchers.delete(repoPath);
    return { success: true };
  }

  /**
   * Handle fs.changed event - route to correct repo watcher.
   * Uses path.relative to ensure the change is actually inside gitDir,
   * not just a path that shares the same prefix (e.g., .git-backup).
   * @param change - The file change event from FileWatcher.
   */
  private async handleFsChange(change: FsChanged): Promise<void> {
    const matches: RepoWatcher[] = [];
    for (const [, watcher] of this.watchers) {
      const relative = path.relative(watcher.gitDir, change.path);
      // If relative path doesn't start with '..', it's inside gitDir
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
        matches.push(watcher);
      }
    }
    if (matches.length === 0) return;
    matches.sort((a, b) => b.gitDir.length - a.gitDir.length);
    for (const watcher of matches) {
      const handled = await this.handleRepoChange(watcher, change);
      if (handled) return;
    }
  }

  /**
   * Narrow an `InterpretResult` type to the subset that can be covered by a native git hook.
   *
   * Only `commit` and `checkout` are suppressible — `merge`, `rebase`, `staging`, and
   * worktree events are always emitted from filesystem inference regardless of hook coverage.
   * @param type - The operation type from a non-null {@link InterpretResult}.
   * @returns `true` when `type` is `'commit'` or `'checkout'`, the two suppressible operations.
   */
  private isSuppressibleOperation(type: NonNullable<InterpretResult>['type']): type is 'commit' | 'checkout' {
    return type === 'commit' || type === 'checkout';
  }

  /**
   * Query the git-hook coverage service to determine whether a native hook already
   * covers the given operation for the repo associated with `watcher`.
   *
   * Uses {@link IMakaioBus.requestOptional} so missing coverage providers preserve
   * filesystem-event emission behaviour. Other coverage failures are also treated
   * as uncovered because native hook coverage is an optimization over the fallback path.
   * @param watcher - The per-repo watcher state providing the repo root path.
   * @param operation - The git operation GitWatcher is about to emit.
   * @param worktree - Worktree name when the change is worktree-scoped, otherwise `undefined`.
   * @returns `true` only when a coverage handler confirms the hook is installed and verified.
   */
  private async isCoveredByNativeHook(
    watcher: RepoWatcher,
    operation: GitHookCoveredOperation,
    worktree: string | undefined,
  ): Promise<boolean> {
    try {
      const result = await this.bus.requestOptional(GitHookSubjects.coverage, {
        repoPath: watcher.repoRoot,
        operation,
        ...(worktree !== undefined && { worktree }),
      });
      return result.handled && result.data.covered;
    } catch (error) {
      console.debug('[GitWatcher] Git hook coverage check failed; preserving fs fallback emission.', {
        repoPath: watcher.repoRoot,
        operation,
        worktree,
        error,
      });
      return false;
    }
  }

  /**
   * Handle change for a specific repo.
   * @param watcher - The repo watcher state.
   * @param change - The file change event.
   * @returns True when the watcher recognized and handled the change.
   */
  private async handleRepoChange(watcher: RepoWatcher, change: FsChanged): Promise<boolean> {
    const result = interpretChangeForRepo(watcher.gitDir, change);
    if (!result) return false;

    if (this.isSuppressibleOperation(result.type)) {
      const covered = await this.isCoveredByNativeHook(watcher, result.type, result.worktree);
      if (covered) {
        return true;
      }
    }

    try {
      const emitters: Record<string, (wt: string | undefined) => Promise<void>> = {
        commit: (wt) => this.emitCommitEvent(watcher, wt),
        checkout: (wt) => this.emitCheckoutEvent(watcher, wt),
        staging: (wt) => this.emitStagingEvent(watcher, wt),
        merge: (wt) => this.emitMergeEvent(watcher, wt),
        rebase: (wt) => this.emitRebaseEvent(watcher, wt),
        'worktree-added': (wt) => this.emitWorktreeEvent(watcher, wt!, 'added'),
        'worktree-removed': (wt) => this.emitWorktreeEvent(watcher, wt!, 'removed'),
      };
      await emitters[result.type](result.worktree);
    } catch (error) {
      console.debug('[GitWatcher] Failed to emit git event for fs change; trying less-specific watcher if available.', {
        repoPath: watcher.repoRoot,
        changePath: change.path,
        error,
      });
      return false;
    }
    return true;
  }

  /**
   * Get working directory for a worktree.
   * @param watcher - The repo watcher state.
   * @param worktree - The worktree name, or undefined for main worktree.
   * @returns The working directory path.
   */
  private async getWorkingDir(watcher: RepoWatcher, worktree: string | undefined): Promise<string> {
    if (!worktree) return watcher.repoRoot;
    const gitDirFile = path.join(watcher.gitDir, 'worktrees', worktree, 'gitdir');
    return resolveWorktreePathFromGitDirFile(gitDirFile);
  }

  private async emitCommitEvent(watcher: RepoWatcher, worktree: string | undefined): Promise<void> {
    const cwd = await this.getWorkingDir(watcher, worktree);
    const commitInfo = await git('log -1 --format="%H%x00%s%x00%an%x00%ae%x00%aI"', cwd);
    const branch = await git('rev-parse --abbrev-ref HEAD', cwd);
    const [hash, message, author, email, timestamp] = commitInfo.split('\x00');
    const payload: GitCommitEvent = {
      repoPath: watcher.repoRoot,
      hash,
      message,
      author,
      email,
      branch,
      timestamp,
      worktree,
    };
    await this.bus.emit(GitSubjects.commit, payload);
  }

  private async emitCheckoutEvent(watcher: RepoWatcher, worktree: string | undefined): Promise<void> {
    const cwd = await this.getWorkingDir(watcher, worktree);
    const currentBranch = await git('rev-parse --abbrev-ref HEAD', cwd);
    const payload: GitCheckoutEvent = {
      repoPath: watcher.repoRoot,
      currentBranch,
      timestamp: new Date().toISOString(),
      worktree,
    };
    await this.bus.emit(GitSubjects.checkout, payload);
  }

  private async emitStagingEvent(watcher: RepoWatcher, worktree: string | undefined): Promise<void> {
    const cwd = await this.getWorkingDir(watcher, worktree);
    const output = await git('diff --cached --name-only', cwd);
    const staged = output.split('\n').filter((f) => f.length > 0);
    const payload: GitStagingEvent = {
      repoPath: watcher.repoRoot,
      staged,
      timestamp: new Date().toISOString(),
      worktree,
    };
    await this.bus.emit(GitSubjects.staging, payload);
  }

  private async emitMergeEvent(watcher: RepoWatcher, worktree: string | undefined): Promise<void> {
    const cwd = await this.getWorkingDir(watcher, worktree);
    const targetBranch = await git('rev-parse --abbrev-ref HEAD', cwd);
    let sourceBranch = 'unknown';
    try {
      const mergeHead = await git('rev-parse MERGE_HEAD', cwd);
      sourceBranch = await git(`name-rev --name-only ${mergeHead}`, cwd);
    } catch {
      /* MERGE_HEAD may not exist */
    }
    const mergeCommit = await git('rev-parse HEAD', cwd);
    const payload: GitMergeEvent = {
      repoPath: watcher.repoRoot,
      sourceBranch,
      targetBranch,
      mergeCommit,
      timestamp: new Date().toISOString(),
      worktree,
    };
    await this.bus.emit(GitSubjects.merge, payload);
  }

  private async emitRebaseEvent(watcher: RepoWatcher, worktree: string | undefined): Promise<void> {
    const cwd = await this.getWorkingDir(watcher, worktree);
    const branch = await git('rev-parse --abbrev-ref HEAD', cwd);
    let onto = 'unknown';
    try {
      onto = await git('rev-parse --abbrev-ref REBASE_HEAD~1', cwd);
    } catch {
      /* May fail during rebase */
    }
    const payload: GitRebaseEvent = {
      repoPath: watcher.repoRoot,
      branch,
      onto,
      status: 'started',
      timestamp: new Date().toISOString(),
      worktree,
    };
    await this.bus.emit(GitSubjects.rebase, payload);
  }

  private async emitWorktreeEvent(watcher: RepoWatcher, name: string, event: 'added' | 'removed'): Promise<void> {
    const gitDirFile = path.join(watcher.gitDir, 'worktrees', name, 'gitdir');
    let worktreePath = pathResolveSibling(watcher.repoRoot, name);
    let branch = name;
    if (event === 'added') {
      try {
        worktreePath = await resolveWorktreePathFromGitDirFile(gitDirFile);
        branch = await git('rev-parse --abbrev-ref HEAD', worktreePath);
      } catch {
        /* Worktree info may not be available yet */
      }
    }
    const payload: GitWorktreeEvent = {
      repoPath: watcher.repoRoot,
      name,
      path: worktreePath,
      branch,
      event,
      timestamp: new Date().toISOString(),
    };
    await this.bus.emit(GitSubjects.worktree, payload);
  }

  /**
   * Interpret a file change for testing purposes.
   * @param gitDir - The .git directory path.
   * @param change - The file change event.
   * @returns Interpretation result or null if unrecognized.
   */
  public interpretChange(gitDir: string, change: FileChange): InterpretResult {
    return interpretChangeForRepo(gitDir, change);
  }
}

/**
 * Compute the conventional sibling path fallback for a worktree name.
 * @param repoRoot - Main repository root
 * @param name - Worktree name
 * @returns Absolute fallback path
 */
function pathResolveSibling(repoRoot: string, name: string): string {
  return path.resolve(repoRoot, '..', name);
}

/**
 * Resolve an absolute worktree root from a gitdir pointer file.
 * @param gitDirFile - Path to the gitdir pointer file
 * @returns Absolute path to worktree root
 */
async function resolveWorktreePathFromGitDirFile(gitDirFile: string): Promise<string> {
  const gitDirRef = (await fs.readFile(gitDirFile, 'utf8')).trim();
  const resolvedGitDir = path.resolve(path.dirname(gitDirFile), gitDirRef);
  return path.basename(resolvedGitDir) === '.git' ? path.dirname(resolvedGitDir) : resolvedGitDir;
}
