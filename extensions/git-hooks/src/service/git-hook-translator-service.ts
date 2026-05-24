/**
 * Translator service for native git hook events.
 *
 * Subscribes to `hook:git.received` on the bus, normalizes raw payloads
 * into typed events, and emits canonical `git.*` events only when Git hook
 * data can honestly satisfy the canonical schema. Native merge/rewrite hook
 * metadata is emitted on `gitHook.*` subjects.
 *
 * Also registers the `GitHookEventsProvider` capability and handles
 * `gitHook.coverage` requests by delegating to that provider.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { GitHookSubjects, registerGitHookEventsProvider, unregisterGitHookEventsProvider } from '@makaio/contracts';
import type { GitCommitEvent, GitCheckoutEvent } from '@makaio/services-core/git/schemas';
import { GitSubjects } from '@makaio/services-core/git/namespace';
import { BaseService } from '@makaio/service-base';
import { createInboundHookReceivedSubject } from '@makaio/inbound-hooks';
import { gitOutput } from '../install/git-command.js';
import { GitHookEventsProvider } from './git-hook-events-provider.js';
import { normalizeGitHookEvent } from './translate.js';

/**
 * Bus service that bridges native git hook events to canonical git subjects.
 *
 * Lifecycle:
 * 1. `init()` — registers `hook:git.received` and `gitHook.coverage` handlers,
 *    then registers the capability provider with the bus.
 * 2. `destroy()` — unregisters the capability provider; bus handlers are
 *    torn down automatically by `BaseService`.
 */
export class GitHookTranslatorService extends BaseService {
  private readonly provider = new GitHookEventsProvider();

  /**
   * @param bus - Bus instance for handler registration and event emission.
   */
  public constructor(bus: IMakaioBus) {
    super(bus);
  }

  protected async onInit(): Promise<void> {
    this.registerHandler(createInboundHookReceivedSubject('git'), async (ctx) => {
      const normalized = normalizeGitHookEvent(ctx.payload);
      if (!normalized) {
        return;
      }
      if (normalized.kind === 'commit') {
        await this.emitCommit(normalized.repoPath);
      } else if (normalized.kind === 'checkout') {
        await this.emitCheckout(normalized.repoPath);
      } else if (normalized.kind === 'merge') {
        await this.emitNativeMerge(normalized.repoPath, normalized.squash);
      } else {
        await this.emitRewrite(normalized.repoPath, normalized.command, normalized.rewritten);
      }
    });

    this.registerHandler(GitHookSubjects.coverage, async (ctx) => {
      ctx.setResult(await this.provider.getCoverage(ctx.payload));
    });

    await registerGitHookEventsProvider(this.bus, this.provider);
  }

  protected async onDestroy(): Promise<void> {
    await unregisterGitHookEventsProvider(this.bus, this.provider.id);
  }

  /**
   * Resolve the latest commit details from git and emit a `git.commit` event.
   * @param repoPath - Absolute path to the repository root.
   */
  private async emitCommit(repoPath: string): Promise<void> {
    const commitInfo = await gitOutput(['log', '-1', '--format=%H%x00%s%x00%an%x00%ae%x00%aI'], repoPath);
    const branch = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    const [hash, message, author, email, timestamp] = commitInfo.split('\x00');
    const payload: GitCommitEvent = {
      repoPath,
      hash: hash ?? '',
      message: message ?? '',
      author: author ?? '',
      email: email ?? '',
      branch,
      timestamp: timestamp ?? new Date().toISOString(),
    };
    await this.bus.emit(GitSubjects.commit, payload);
  }

  /**
   * Resolve the current branch name and emit a `git.checkout` event.
   *
   * Git's `post-checkout` hook provides previous/new HEAD values, not branch
   * names, so `previousBranch` is intentionally omitted.
   * @param repoPath - Absolute path to the repository root.
   */
  private async emitCheckout(repoPath: string): Promise<void> {
    const currentBranch = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    const payload: GitCheckoutEvent = {
      repoPath,
      currentBranch,
      timestamp: new Date().toISOString(),
    };
    await this.bus.emit(GitSubjects.checkout, payload);
  }

  /**
   * Resolve available post-merge metadata and emit a native hook merge event.
   *
   * Git's post-merge hook does not provide the source branch required by the
   * canonical `git.merge` event, so the hook event is emitted under `gitHook`.
   * @param repoPath - Absolute path to the repository root.
   * @param squash - Whether Git reported a squash merge.
   */
  private async emitNativeMerge(repoPath: string, squash: boolean): Promise<void> {
    const [targetBranch, currentHead] = await Promise.all([
      gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
      gitOutput(['rev-parse', 'HEAD'], repoPath),
    ]);
    await this.bus.emit(GitHookSubjects.merge, {
      repoPath,
      squash,
      targetBranch,
      currentHead,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Resolve the current branch and emit a native hook rewrite event.
   *
   * Git's post-rewrite hook provides the rewrite command and old/new commit
   * pairs, but not the `onto` field required by the canonical `git.rebase`
   * event.
   * @param repoPath - Absolute path to the repository root.
   * @param command - Rewrite command passed by Git, such as `rebase` or `amend`.
   * @param rewritten - Old/new commit hash pairs from hook stdin.
   */
  private async emitRewrite(
    repoPath: string,
    command: string,
    rewritten: readonly { readonly oldHash: string; readonly newHash: string }[],
  ): Promise<void> {
    const branch = await gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
    await this.bus.emit(GitHookSubjects.rewrite, {
      repoPath,
      command,
      rewritten: [...rewritten],
      branch,
      timestamp: new Date().toISOString(),
    });
  }
}
