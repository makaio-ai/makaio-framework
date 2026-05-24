/**
 * Git remote operations (push, pull, fetch).
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { PushResult, PushOptions, PullResult, PullOptions, FetchResult, FetchOptions } from './types.js';

/**
 * Normalize an unknown error to a readable message.
 * @param err - Thrown value
 * @param fallback - Fallback message when error is not an Error
 * @returns Error message
 */
function getErrorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Push commits to a remote.
 *
 * Note: Force push is intentionally NOT supported. The task spec requires
 * an explicit confirmation seam before force push can be added.
 * @param git - SimpleGit instance
 * @param remote - Remote name (defaults to 'origin')
 * @param branch - Branch name (defaults to current branch)
 * @param options - Optional push configuration
 * @returns Push result
 */
export async function push(
  git: SimpleGit,
  remote?: string,
  branch?: string,
  options?: PushOptions,
): Promise<PushResult> {
  try {
    const args: string[] = ['push'];
    const resolvedRemote = remote ?? 'origin';

    if (options?.setUpstream) {
      args.push('-u');
    }
    if (options?.tags) {
      args.push('--tags');
    }

    args.push(resolvedRemote);
    if (branch) {
      args.push(branch);
    }

    await git.raw(args);

    return {
      success: true,
      remote: resolvedRemote,
      branch: branch ?? undefined,
    };
  } catch (err) {
    return {
      success: false,
      error: getErrorMessage(err, 'Failed to push'),
    };
  }
}

/**
 * Pull changes from a remote.
 * @param git - SimpleGit instance
 * @param remote - Remote name (defaults to 'origin')
 * @param branch - Branch name (defaults to current tracking branch)
 * @param options - Optional pull configuration
 * @returns Pull result with update and conflict info
 */
export async function pull(
  git: SimpleGit,
  remote?: string,
  branch?: string,
  options?: PullOptions,
): Promise<PullResult> {
  try {
    const args: string[] = ['pull'];
    const resolvedRemote = remote ?? 'origin';

    if (options?.rebase) {
      args.push('--rebase');
    }

    args.push(resolvedRemote);
    if (branch) {
      args.push(branch);
    }

    const output = await git.raw(args);
    const updated = !output.includes('Already up to date');

    return {
      success: true,
      updated,
    };
  } catch (err) {
    const errorMessage = getErrorMessage(err, 'Failed to pull');

    // Detect merge conflicts
    if (errorMessage.includes('CONFLICT') || errorMessage.includes('fix conflicts')) {
      const status = await git.status().catch(() => null);
      return {
        success: false,
        updated: true,
        conflicts: status?.conflicted ?? [],
        error: 'Pull resulted in merge conflicts',
      };
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Fetch refs from a remote.
 * @param git - SimpleGit instance
 * @param remote - Remote name (defaults to 'origin')
 * @param options - Optional fetch configuration
 * @returns Fetch result
 */
export async function fetch(git: SimpleGit, remote?: string, options?: FetchOptions): Promise<FetchResult> {
  try {
    const args: string[] = ['fetch'];
    const resolvedRemote = options?.all ? undefined : (remote ?? 'origin');

    if (options?.all) {
      args.push('--all');
    } else if (resolvedRemote) {
      args.push(resolvedRemote);
    }

    if (options?.prune) {
      args.push('--prune');
    }
    if (options?.tags) {
      args.push('--tags');
    }

    await git.raw(args);

    return {
      success: true,
      remote: options?.all ? 'all' : resolvedRemote,
    };
  } catch (err) {
    return {
      success: false,
      error: getErrorMessage(err, 'Failed to fetch'),
    };
  }
}
