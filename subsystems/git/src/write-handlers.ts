/**
 * Bus handler registration for git write operations.
 *
 * Wires command functions to the git-service namespace subjects.
 * Each handler delegates to a pure command function and maps the
 * result to the git-service response schema.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { GitSubjects } from './namespace.js';
import { getGit, getBranch } from './queries/index.js';
import {
  commitChanges,
  mergeBranch,
  abortMerge,
  rebase,
  stashPush,
  stashPop,
  stashApply,
  stashList,
  stashDrop,
  createBranch,
  deleteBranch,
  renameBranch,
  checkoutRef,
  push,
  pull,
  fetch,
  discardChanges,
} from './commands/index.js';

/**
 * Resolve repository path from a request payload.
 * @param request - Request with optional repoPath property
 * @returns Repository path string (falls back to cwd)
 */
function resolveRepoPath(request: { repoPath?: string }): string {
  return request.repoPath ?? process.cwd();
}

/**
 * Register commit and discard handlers.
 * @param bus - Bus instance
 * @returns Array of cleanup functions
 */
function registerCommitHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(GitSubjects.createCommit, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await commitChanges(git, ctx.payload.message, {
        amend: ctx.payload.amend,
        allowEmpty: ctx.payload.allowEmpty,
      });
      if (result.success) {
        const branch = (await getBranch(git)).current;
        ctx.setResult({ success: true, hash: result.hash, branch });
      } else {
        ctx.setResult({ success: false, error: result.error });
      }
    }),
    bus.on(GitSubjects.discardChanges, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await discardChanges(git, ctx.payload.paths);
      ctx.setResult(result);
    }),
  ];
}

/**
 * Register branch CRUD and checkout handlers.
 * @param bus - Bus instance
 * @returns Array of cleanup functions
 */
function registerBranchHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(GitSubjects.createBranch, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await createBranch(git, ctx.payload.name, ctx.payload.startPoint);
      if (result.success && ctx.payload.checkout) {
        const checkoutResult = await checkoutRef(git, ctx.payload.name);
        if (!checkoutResult.success) {
          ctx.setResult({
            success: false,
            name: result.branch,
            error: checkoutResult.error ?? `Branch "${result.branch}" was created but checkout failed.`,
          });
          return;
        }
      }
      ctx.setResult({ success: result.success, name: result.branch, error: result.error });
    }),
    bus.on(GitSubjects.deleteBranch, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await deleteBranch(git, ctx.payload.name, ctx.payload.force);
      ctx.setResult({ success: result.success, error: result.error });
    }),
    bus.on(GitSubjects.renameBranch, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await renameBranch(git, ctx.payload.oldName, ctx.payload.newName);
      ctx.setResult(result);
    }),
    bus.on(GitSubjects.checkoutRef, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await checkoutRef(git, ctx.payload.ref, {
        createBranch: ctx.payload.createBranch,
        startPoint: ctx.payload.startPoint,
      });
      ctx.setResult({ success: result.success, ref: result.target, error: result.error });
    }),
  ];
}

/**
 * Register merge and rebase handlers.
 * @param bus - Bus instance
 * @returns Array of cleanup functions
 */
function registerMergeRebaseHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(GitSubjects.mergeBranch, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await mergeBranch(git, ctx.payload.source, {
        squash: ctx.payload.approach === 'squash',
        // Preserve native merge behavior when approach is omitted:
        // fast-forward if possible, merge commit otherwise.
        noFf: ctx.payload.approach === 'merge',
        ffOnly: ctx.payload.approach === 'fast-forward-only',
        message: ctx.payload.message,
      });
      if (!result.success && ctx.payload.abortOnConflict && result.conflicts?.length) {
        await abortMerge(git);
      }
      ctx.setResult({
        success: result.success,
        hash: result.mergeCommit,
        fastForward: result.fastForward,
        conflicts: result.conflicts,
        error: result.error,
      });
    }),
    bus.on(GitSubjects.mergeAbort, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await abortMerge(git);
      ctx.setResult({ success: result.success, error: result.error });
    }),
    bus.on(GitSubjects.rebaseOnto, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);

      if (ctx.payload.abort) {
        const result = await rebase(git, '', { action: 'abort' });
        ctx.setResult({ success: result.success, error: result.error });
        return;
      }
      if (ctx.payload.continueRebase) {
        const result = await rebase(git, '', { action: 'continue' });
        ctx.setResult({ success: result.success, error: result.error });
        return;
      }

      const result = await rebase(git, ctx.payload.onto, { autoStash: true });
      const hash = result.success ? (await git.revparse(['HEAD'])).trim() : undefined;
      ctx.setResult({
        success: result.success,
        hash,
        conflicts: result.conflicts,
        error: result.error,
      });
    }),
  ];
}

/**
 * Register stash handler for all stash operations (push, pop, apply, drop, list).
 * @param bus - Bus instance
 * @returns Array of cleanup functions
 */
function registerStashHandler(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(GitSubjects.stash, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const { operation, message, includeUntracked, index } = ctx.payload;

      // operation is schema-validated to a fixed enum, but keep a default fallback
      // so callers that bypass schema validation still receive a response.
      switch (operation) {
        case 'push': {
          const result = await stashPush(git, { message, includeUntracked });
          ctx.setResult({ success: result.success, error: result.error });
          break;
        }
        case 'pop': {
          const result = await stashPop(git, { index });
          ctx.setResult({ success: result.success, error: result.error });
          break;
        }
        case 'apply': {
          const result = await stashApply(git, { index });
          ctx.setResult({ success: result.success, error: result.error });
          break;
        }
        case 'drop': {
          const result = await stashDrop(git, { index });
          ctx.setResult({ success: result.success, error: result.error });
          break;
        }
        case 'list': {
          const result = await stashList(git);
          const entries = result.entries?.map((e) => ({
            index: e.index,
            message: e.message,
            branch: e.branch,
            date: e.date,
          }));
          ctx.setResult({ success: result.success, entries, error: result.error });
          break;
        }
        default: {
          const impossibleOperation: never = operation;
          ctx.setResult({
            success: false,
            error: `Unsupported stash operation: ${String(impossibleOperation)}`,
          });
        }
      }
    }),
  ];
}

/**
 * Register push, pull, and fetch handlers.
 * @param bus - Bus instance
 * @returns Array of cleanup functions
 */
function registerRemoteOpsHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(GitSubjects.push, async (ctx) => {
      // Force push requires an explicit confirmation seam (not yet implemented).
      // Reject at the handler level to prevent accidental data loss.
      if (ctx.payload.force) {
        ctx.setResult({
          success: false,
          error: 'Force push is not supported. A confirmation seam must be implemented first.',
        });
        return;
      }
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await push(git, ctx.payload.remote, ctx.payload.branch, {
        setUpstream: ctx.payload.setUpstream,
      });
      ctx.setResult({
        success: result.success,
        remote: result.remote,
        branch: result.branch,
        error: result.error,
      });
    }),
    bus.on(GitSubjects.pull, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const result = await pull(git, ctx.payload.remote, ctx.payload.branch, {
        rebase: ctx.payload.rebase,
      });
      ctx.setResult({
        success: result.success,
        conflicts: result.conflicts,
        error: result.error,
      });
    }),
    bus.on(GitSubjects.fetch, async (ctx) => {
      const repoPath = resolveRepoPath(ctx.payload);
      const git = getGit(repoPath);
      const isAll = ctx.payload.remote === '--all';
      const result = await fetch(git, isAll ? undefined : ctx.payload.remote, {
        all: isAll,
        prune: ctx.payload.prune,
      });
      ctx.setResult({ success: result.success, error: result.error });
    }),
  ];
}

/**
 * Register all git write operation handlers on the bus.
 *
 * Call this from GitService.init() to wire write commands.
 * Returns an array of cleanup functions to be called on destroy.
 * @param bus - Bus instance
 * @returns Array of cleanup functions for all registered handlers
 */
export function registerWriteHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    ...registerCommitHandlers(bus),
    ...registerBranchHandlers(bus),
    ...registerMergeRebaseHandlers(bus),
    ...registerStashHandler(bus),
    ...registerRemoteOpsHandlers(bus),
  ];
}
