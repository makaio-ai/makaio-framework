/**
 * Git stash commands (push, pop, list, drop, apply).
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { StashResult, StashEntry, StashPushOptions, StashPopOptions, StashDropOptions } from './types.js';

/**
 * Execute a stash subcommand with shared error handling.
 * @param git - SimpleGit instance
 * @param args - Full stash command args
 * @param fallbackMessage - Error fallback message
 * @param successResult - Result payload for successful execution
 * @returns Stash result
 */
async function runStashCommand(
  git: SimpleGit,
  args: string[],
  fallbackMessage: string,
  successResult: StashResult,
): Promise<StashResult> {
  try {
    await git.raw(args);
    return successResult;
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : fallbackMessage,
    };
  }
}

/**
 * Check whether stash push would create an entry for the given options.
 * @param git - SimpleGit instance
 * @param includeUntracked - Whether untracked files are included
 * @returns True when there are stashable changes
 */
async function hasStashableChanges(git: SimpleGit, includeUntracked: boolean): Promise<boolean> {
  const porcelain = await git.raw(['status', '--porcelain']);
  const lines = porcelain
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  return includeUntracked ? true : lines.some((line) => !line.startsWith('??'));
}

/**
 * Push changes to the stash.
 * @param git - SimpleGit instance
 * @param options - Optional stash push configuration
 * @returns Stash result with reference
 */
export async function stashPush(git: SimpleGit, options?: StashPushOptions): Promise<StashResult> {
  const includeUntracked = options?.includeUntracked ?? false;
  if (!(await hasStashableChanges(git, includeUntracked))) {
    return { success: false, error: 'No local changes to stash' };
  }

  const args = ['stash', 'push'];
  if (options?.message) {
    args.push('-m', options.message);
  }
  if (includeUntracked) {
    args.push('--include-untracked');
  }
  return runStashCommand(git, args, 'Failed to stash push', { success: true, ref: 'stash@{0}' });
}

/**
 * Pop the top stash entry (remove from stash and apply).
 * @param git - SimpleGit instance
 * @param options - Optional stash pop configuration
 * @returns Stash result
 */
export async function stashPop(git: SimpleGit, options?: StashPopOptions): Promise<StashResult> {
  const args = ['stash', 'pop'];
  if (options?.index !== undefined) {
    args.push(`stash@{${options.index}}`);
  }
  return runStashCommand(git, args, 'Failed to stash pop', { success: true });
}

/**
 * Apply a stash entry without removing it from the stash list.
 * @param git - SimpleGit instance
 * @param options - Optional stash apply configuration
 * @returns Stash result
 */
export async function stashApply(git: SimpleGit, options?: StashPopOptions): Promise<StashResult> {
  const args = ['stash', 'apply'];
  if (options?.index !== undefined) {
    args.push(`stash@{${options.index}}`);
  }
  return runStashCommand(git, args, 'Failed to stash apply', { success: true });
}

/**
 * Extract branch name from a stash reflog subject.
 *
 * Git stash subjects follow the pattern:
 * - `"WIP on <branch>: <hash> <commit msg>"`  (default stash)
 * - `"On <branch>: <user message>"`            (stash with -m)
 * @param subject - Reflog subject string (`%gs`)
 * @returns Branch name or empty string if unparseable
 */
function parseBranchFromStashSubject(subject: string): string {
  const match = subject.match(/^(?:WIP on|On) ([^:]+):/);
  return match?.[1] ?? '';
}

/**
 * List all stash entries.
 *
 * Format string: `%gd` (reflog selector), `%aI` (author date ISO 8601),
 * `%gs` (reflog subject). Branch is extracted from the standard stash
 * subject prefix.
 * @param git - SimpleGit instance
 * @returns Stash result with entries
 */
export async function stashList(git: SimpleGit): Promise<StashResult> {
  try {
    const output = await git.raw(['stash', 'list', '--format=%gd|%aI|%gs']);
    const entries: StashEntry[] = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        const [ref, date, ...messageParts] = line.split('|');
        const subject = messageParts.join('|');
        return {
          index,
          ref: ref || `stash@{${index}}`,
          message: subject,
          branch: parseBranchFromStashSubject(subject),
          date: date || new Date(0).toISOString(),
        };
      });
    return { success: true, entries };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Failed to list stashes',
    };
  }
}

/**
 * Drop a stash entry.
 * @param git - SimpleGit instance
 * @param options - Optional stash drop configuration
 * @returns Stash result
 */
export async function stashDrop(git: SimpleGit, options?: StashDropOptions): Promise<StashResult> {
  const args = ['stash', 'drop'];
  if (options?.index !== undefined) {
    args.push(`stash@{${options.index}}`);
  }
  return runStashCommand(git, args, 'Failed to drop stash', { success: true });
}
