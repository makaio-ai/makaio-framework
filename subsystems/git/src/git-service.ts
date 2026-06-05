import path from 'node:path';
import type { IMakaioBus } from '@makaio/bus-core';
import { FsSubjects } from '@makaio/services-core/filesystem/namespace';
import { BaseService } from '@makaio/service-base';
import { GitSubjects } from '@makaio/services-core/git/namespace';
import {
  getGit,
  getRepoRoot,
  getBranch,
  getCommit,
  getCommitDetails,
  getWorkingTreeDetails,
  getStatus,
  getWorktrees,
  getRemotes,
  getDefaultBranch,
  initRepo,
  createWorktree,
  removeWorktree,
  getLog,
  getFileAtRevision,
  getFileAtCommit,
  getBlobHashAtCommit,
  getDiff,
  stageFiles,
  unstageFiles,
  getBranchCommits,
} from './queries/index.js';
import { GitWatcher } from './git-watcher.js';
import { GitLogCache } from './git-log-cache.js';
import { GitWorkingTreeCache } from './git-working-tree-cache.js';
import { GitFingerprintCache } from './git-fingerprint-cache.js';
import { computeFingerprint } from './git-fingerprint.js';
import { resolveLogRepoPath } from './log-repo-path.js';
import { normalizeLogRequest } from './log-request-normalizer.js';
import { resolveInvalidationRoot } from './invalidation-root.js';

/**
 * GitService provides git repository functionality via bus requests.
 *
 * Combines:
 * - Query operations:
 *   - getRepoRoot, getBranch, getCommit, getStatus, getWorktrees, getRemotes, getDefaultBranch
 *   - getLog, getFileAtRevision
 *   - getFileAtCommit — returns file content at a commit with null-safe binary/missing semantics
 *   - getBlobHashAtCommit — returns blob hash for divergence checks
 * - File watching: monitors .git directories and emits events (commit, checkout, staging, etc.)
 * - Multi-repo support: addRepo/removeRepo for watching multiple repositories
 * @example
 * ```typescript
 * import { MakaioBus } from '@makaio/bus-core';
 * import { GitService } from '@makaio/services-core/git';
 * import { GitSubjects } from '@makaio/services-core/git/namespace';
 *
 * // Initialize the service
 * const gitService = new GitService(bus);
 * await gitService.init();
 *
 * // Make requests via bus
 * const branch = await bus.request(GitSubjects.getBranch, {});
 * console.log('Current branch:', branch.current);
 *
 * // Watch a repo for events
 * await bus.request(GitSubjects.addRepo, { repoPath: '/path/to/repo' });
 *
 * // Listen for git events
 * bus.on(GitSubjects.commit, (ctx) => {
 *   console.log('New commit:', ctx.payload.hash);
 * });
 *
 * // Cleanup when done
 * await gitService.destroy();
 * ```
 */
export class GitService extends BaseService {
  private readonly watcher: GitWatcher;
  private readonly logCache = new GitLogCache();
  private readonly workingTreeCache = new GitWorkingTreeCache();
  private readonly fingerprintCache = new GitFingerprintCache();

  /**
   * @param bus - Bus instance for registering handlers
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
    this.watcher = new GitWatcher(bus);
  }

  protected async onInit(): Promise<void> {
    // Register query handlers
    this.registerQueryHandlers();

    // Register fingerprint handler
    this.registerFingerprintHandler();

    // Initialize watcher (registers addRepo, removeRepo, and fs.changed handlers)
    await this.watcher.init();

    // Subscribe to invalidating events for cache management
    this.registerCacheInvalidationHandlers();
  }

  protected async onDestroy(): Promise<void> {
    this.logCache.clear();
    this.workingTreeCache.clear();
    this.fingerprintCache.clear();
    await this.watcher.destroy();
  }

  /**
   * Register query request handlers on the bus.
   */
  private registerQueryHandlers(): void {
    this.registerGitStateHandlers();
    this.registerHistoryHandlers();
    this.registerWorktreeManagementHandlers();
  }

  private registerGitStateHandlers(): void {
    // getRepoRoot handler
    this.registerHandler(GitSubjects.getRepoRoot, async (ctx) => {
      const result = await getRepoRoot(ctx.payload.path);
      ctx.setResult(result);
    });

    // getBranch handler
    this.registerHandler(GitSubjects.getBranch, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getBranch(git);
      ctx.setResult(result);
    });

    // getStatus handler
    this.registerHandler(GitSubjects.getStatus, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getStatus(git);
      ctx.setResult(result);
    });
  }

  /* eslint max-lines-per-function: ["error", { "max": 150 }] */
  private registerHistoryHandlers(): void {
    // getCommit handler
    this.registerHandler(GitSubjects.getCommit, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getCommit(git, ctx.payload.ref);
      ctx.setResult(result);
    });

    // getCommitDetails handler
    this.registerHandler(GitSubjects.getCommitDetails, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getCommitDetails(git, ctx.payload.hash);
      ctx.setResult(result);
    });

    // getWorkingTreeDetails handler (with caching)
    this.registerHandler(GitSubjects.getWorkingTreeDetails, async (ctx) => {
      const repoPath = this.resolveRepoPath(ctx.payload);
      const cached = this.workingTreeCache.get(ctx.payload, repoPath);
      if (cached) {
        ctx.setResult(cached);
        return;
      }

      const git = getGit(repoPath);
      const result = await getWorkingTreeDetails(git);

      const invalidationRoot = await resolveInvalidationRoot(repoPath);
      this.workingTreeCache.set(ctx.payload, repoPath, invalidationRoot, result);

      ctx.setResult(result);
    });

    // getWorktrees handler — gracefully handles deleted/moved repo paths
    this.registerHandler(GitSubjects.getWorktrees, async (ctx) => {
      try {
        const git = getGit(ctx.payload.repoPath);
        const result = await getWorktrees(git);
        ctx.setResult(result);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const errorCode = (error as NodeJS.ErrnoException)?.code;
        const errorMsg = err.message.toLowerCase();

        // Only swallow repository-not-found/path-missing errors
        const isMissingPathError =
          errorCode === 'ENOENT' ||
          errorMsg.includes('no such file or directory') ||
          errorMsg.includes('not a git repository') ||
          errorMsg.includes('does not exist');

        if (isMissingPathError) {
          // Log for diagnostics and return graceful fallback
          console.debug('[GitService] getWorktrees failed for missing path, returning empty array', {
            repoPath: ctx.payload.repoPath,
            error: err.message,
          });
          ctx.setResult({ worktrees: [] });
        } else {
          // Rethrow unexpected errors so upstream can surface real failures
          console.error('[GitService] getWorktrees failed with unexpected error', {
            repoPath: ctx.payload.repoPath,
            error: err.message,
          });
          throw error;
        }
      }
    });

    // getRemotes handler
    this.registerHandler(GitSubjects.getRemotes, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getRemotes(git);
      ctx.setResult(result);
    });

    // getDefaultBranch handler
    this.registerHandler(GitSubjects.getDefaultBranch, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getDefaultBranch(git);
      ctx.setResult(result);
    });

    // getLog handler (with caching)
    this.registerHandler(GitSubjects.getLog, async (ctx) => {
      const repoPath = this.resolveRepoPath(ctx.payload);
      const logRepoPath = await resolveLogRepoPath(repoPath, ctx.payload.filters?.selectedWorktree);
      const normalizedRequest = normalizeLogRequest(ctx.payload, logRepoPath);
      // Normalize selectedWorktree before keying to avoid cache fragmentation.
      const cached = this.logCache.get(normalizedRequest, repoPath);
      if (cached) {
        ctx.setResult(cached);
        return;
      }
      const git = getGit(logRepoPath);
      const result = await getLog(git, normalizedRequest.limit, normalizedRequest.ref, normalizedRequest.filters);
      const invalidationRoot = await resolveInvalidationRoot(repoPath);
      this.logCache.set(normalizedRequest, repoPath, invalidationRoot, result);
      ctx.setResult(result);
    });

    // getFileAtRevision handler
    this.registerHandler(GitSubjects.getFileAtRevision, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getFileAtRevision(git, ctx.payload.path, ctx.payload.ref);
      ctx.setResult(result);
    });

    // getFileAtCommit handler (null-safe: returns null content when file not present at commit)
    this.registerHandler(GitSubjects.getFileAtCommit, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getFileAtCommit(git, ctx.payload.filePath, ctx.payload.commitHash);
      ctx.setResult(result);
    });

    // getBlobHashAtCommit handler (efficient divergence check via blob hash)
    this.registerHandler(GitSubjects.getBlobHashAtCommit, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getBlobHashAtCommit(git, ctx.payload.filePath, ctx.payload.commitHash);
      ctx.setResult(result);
    });

    // getDiff handler
    this.registerHandler(GitSubjects.getDiff, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const result = await getDiff(git, ctx.payload.ref, ctx.payload.staged, ctx.payload.unified, ctx.payload.paths);
      ctx.setResult(result);
    });

    // getBranchCommits handler
    this.registerHandler(GitSubjects.getBranchCommits, async (ctx) => {
      const git = getGit(ctx.payload.repoPath);
      const commitHashes = await getBranchCommits(git, ctx.payload.branchName);
      ctx.setResult({ commitHashes });
    });
  }

  private registerWorktreeManagementHandlers(): void {
    // initRepo handler — mutates filesystem, host-owned
    this.registerHandler(GitSubjects.initRepo, async (ctx) => {
      this.requireHostOwnedOrigin(ctx, 'initRepo');
      const result = await initRepo(ctx.payload.path, ctx.payload.defaultBranch);
      ctx.setResult(result);
    });

    // createWorktree handler — mutates filesystem, host-owned
    this.registerHandler(GitSubjects.createWorktree, async (ctx) => {
      this.requireHostOwnedOrigin(ctx, 'createWorktree');
      const git = getGit(ctx.payload.repoPath);
      const result = await createWorktree(git, ctx.payload.path, ctx.payload.branch, {
        baseBranch: ctx.payload.baseBranch,
        createBranch: ctx.payload.createBranch,
      });
      ctx.setResult(result);
    });

    // removeWorktree handler — mutates filesystem, host-owned
    this.registerHandler(GitSubjects.removeWorktree, async (ctx) => {
      this.requireHostOwnedOrigin(ctx, 'removeWorktree');
      const git = getGit(ctx.payload.repoPath);
      const result = await removeWorktree(git, ctx.payload.path, {
        force: ctx.payload.force,
        deleteBranch: ctx.payload.deleteBranch,
      });
      ctx.setResult(result);
    });

    // stage handler — mutates git index, host-owned
    this.registerHandler(GitSubjects.stage, async (ctx) => {
      this.requireHostOwnedOrigin(ctx, 'stage');
      const { repoPath, paths } = ctx.payload;
      const git = getGit(repoPath);
      const result = await stageFiles(git, paths);
      ctx.setResult(result);
    });

    // unstage handler — mutates git index, host-owned
    this.registerHandler(GitSubjects.unstage, async (ctx) => {
      this.requireHostOwnedOrigin(ctx, 'unstage');
      const { repoPath, paths } = ctx.payload;
      const git = getGit(repoPath);
      const result = await unstageFiles(git, paths);
      ctx.setResult(result);
    });
  }

  /**
   * Assert that a git mutation came from host-owned code or the host UI bridge.
   * @param ctx - Bus handler context carrying origin and transport metadata.
   * @param handlerName - Git handler name used in the error message.
   */
  private requireHostOwnedOrigin(
    ctx: { origin: { local: boolean }; transport?: { transportName: string; peer?: unknown } },
    handlerName: string,
  ): void {
    if (ctx.origin.local || (ctx.transport?.transportName === 'worker' && ctx.transport.peer === undefined)) {
      return;
    }
    throw new Error(`Unauthorized: git.${handlerName} requires a host-owned request`);
  }

  /**
   * Register the fingerprint request handler on the bus.
   *
   * Serves cached results when available. On a miss, computes the fingerprint
   * via {@link computeFingerprint} and stores it under the resolved invalidation root.
   */
  private registerFingerprintHandler(): void {
    this.registerHandler(GitSubjects.fingerprint, async (ctx) => {
      const { repoPath, include, exclude, worktree } = ctx.payload;
      const cached = this.fingerprintCache.get(ctx.payload, repoPath);
      if (cached) {
        ctx.setResult(cached);
        return;
      }

      const result = await computeFingerprint(repoPath, include, exclude, worktree);

      const invalidationRoot = await resolveInvalidationRoot(repoPath);
      this.fingerprintCache.set(ctx.payload, repoPath, invalidationRoot, result);

      ctx.setResult(result);
    });
  }

  /**
   * Invalidate all log cache entries for a specific repository.
   * @param repoPath - Repository path to invalidate
   */
  private async invalidateLogCache(repoPath: string): Promise<void> {
    const invalidationRoot = await resolveInvalidationRoot(repoPath);
    this.logCache.invalidate(invalidationRoot);
  }

  /**
   * Invalidate all working tree cache entries for a specific repository.
   * @param repoPath - Repository path to invalidate
   */
  private async invalidateWorkingTreeCache(repoPath: string): Promise<void> {
    const invalidationRoot = await resolveInvalidationRoot(repoPath);
    this.workingTreeCache.invalidate(invalidationRoot);
  }

  /**
   * Invalidate all fingerprint cache entries for a specific repository.
   * @param repoPath - Repository path to invalidate
   */
  private async invalidateFingerprintCache(repoPath: string): Promise<void> {
    const invalidationRoot = await resolveInvalidationRoot(repoPath);
    this.fingerprintCache.invalidate(invalidationRoot);
  }

  /**
   * Resolve repository path for caching and git operations.
   * @param request - Request with optional repoPath property
   * @returns Repository path string
   */
  private resolveRepoPath(request: { repoPath?: string }): string {
    return request.repoPath ?? process.cwd();
  }

  /**
   * Register handlers that invalidate caches on relevant git events.
   */
  private registerCacheInvalidationHandlers(): void {
    // commit event - invalidates log, working tree, and fingerprint caches
    this.registerHandler(GitSubjects.commit, async (ctx) => {
      await this.invalidateLogCache(ctx.payload.repoPath);
      await this.invalidateWorkingTreeCache(ctx.payload.repoPath);
      await this.invalidateFingerprintCache(ctx.payload.repoPath);
    });

    // checkout event - invalidates log, working tree, and fingerprint caches
    this.registerHandler(GitSubjects.checkout, async (ctx) => {
      await this.invalidateLogCache(ctx.payload.repoPath);
      await this.invalidateWorkingTreeCache(ctx.payload.repoPath);
      await this.invalidateFingerprintCache(ctx.payload.repoPath);
    });

    // staging event - invalidates working tree and fingerprint caches
    this.registerHandler(GitSubjects.staging, async (ctx) => {
      await this.invalidateWorkingTreeCache(ctx.payload.repoPath);
      await this.invalidateFingerprintCache(ctx.payload.repoPath);
    });

    // merge event - invalidates log, working tree, and fingerprint caches
    this.registerHandler(GitSubjects.merge, async (ctx) => {
      await this.invalidateLogCache(ctx.payload.repoPath);
      await this.invalidateWorkingTreeCache(ctx.payload.repoPath);
      await this.invalidateFingerprintCache(ctx.payload.repoPath);
    });

    // rebase event - invalidates log, working tree, and fingerprint caches
    this.registerHandler(GitSubjects.rebase, async (ctx) => {
      await this.invalidateLogCache(ctx.payload.repoPath);
      await this.invalidateWorkingTreeCache(ctx.payload.repoPath);
      await this.invalidateFingerprintCache(ctx.payload.repoPath);
    });

    // fs.batch event - invalidates fingerprint cache for edited source files on disk
    // Note: change.path is a file path, not a repo path. Use path.dirname() because
    // resolveInvalidationRoot calls simpleGit() which expects a directory, not a file.
    this.registerHandler(FsSubjects.batch, async (ctx) => {
      const roots = new Set<string>();
      const rootResults = await Promise.allSettled(
        ctx.payload.changes.map((change) => resolveInvalidationRoot(path.dirname(change.path))),
      );
      for (let index = 0; index < rootResults.length; index++) {
        const result = rootResults[index];
        if (result.status === 'fulfilled') {
          roots.add(result.value);
          continue;
        }
        const changePath = ctx.payload.changes[index]?.path;
        // Keep behavior (ignore failures), but surface path-level diagnostics for invalid roots.
        console.debug('[GitService] Failed to resolve invalidation root for fs.batch change', {
          path: changePath,
          reason: result.reason,
        });
      }
      for (const root of roots) {
        this.fingerprintCache.invalidate(root);
      }
    });
  }
}
