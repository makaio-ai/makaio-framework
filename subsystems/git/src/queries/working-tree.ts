/**
 * Git working tree queries.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { GitStatusResponse, GitWorkingTreeDetailsResponse } from '../schemas.js';

/** File-level diff statistics from numstat output. */
interface FileStats {
  additions: number;
  deletions: number;
}

/**
 * Parse a numstat diff into a path stats map.
 * @param raw - Raw numstat output
 * @returns Map of path to additions/deletions
 */
function parseNumStat(raw: string): Map<string, FileStats> {
  const statsMap = new Map<string, FileStats>();
  const records = raw.split('\0').filter((record) => record.length > 0);

  for (let index = 0; index < records.length; index += 1) {
    const header = records[index];
    if (!header) continue;
    const [adds = '', dels = '', pathToken = ''] = header.split('\t');
    if (!adds || !dels) continue;

    const additions = adds === '-' ? 0 : parseInt(adds, 10) || 0;
    const deletions = dels === '-' ? 0 : parseInt(dels, 10) || 0;

    if (pathToken.length > 0) {
      statsMap.set(pathToken, { additions, deletions });
      continue;
    }

    const newPath = records[index + 2];
    if (newPath) {
      statsMap.set(newPath, { additions, deletions });
    }
    index += 2;
  }
  return statsMap;
}

/**
 * Parse a name-status diff into a rename map keyed by new path.
 * @param raw - Raw name-status output
 * @returns Map of new path to old path for rename entries
 */
function parseRenameMap(raw: string): Map<string, string> {
  const renameMap = new Map<string, string>();
  const records = raw.split('\0').filter((record) => record.length > 0);

  for (let index = 0; index < records.length; index += 1) {
    const status = records[index];
    if (!status?.startsWith('R')) {
      // Non-rename records are [status, path]; skip the path token so a path like
      // "README.md" is not misread as the next status record.
      index += 1;
      continue;
    }
    const oldPath = records[index + 1];
    const newPath = records[index + 2];
    if (oldPath && newPath) {
      renameMap.set(newPath, oldPath);
    }
    index += 2;
  }
  return renameMap;
}

/**
 * Merge stats from source into target.
 * @param target - Destination stats map
 * @param source - Source stats map
 */
function mergeStats(target: Map<string, FileStats>, source: Map<string, FileStats>): void {
  for (const [path, stats] of source) {
    const current = target.get(path) ?? { additions: 0, deletions: 0 };
    current.additions += stats.additions;
    current.deletions += stats.deletions;
    target.set(path, current);
  }
}

/**
 * Get working tree changes (files and stats).
 * @param git - SimpleGit instance
 * @returns Working tree files and aggregate stats
 */
export async function getWorkingTreeDetails(git: SimpleGit): Promise<GitWorkingTreeDetailsResponse> {
  const status = await git.status();
  const [unstagedRaw, stagedRaw, unstagedNameStatusRaw, stagedNameStatusRaw] = await Promise.all([
    git.raw(['diff', '-M', '--numstat', '-z']),
    git.raw(['diff', '--cached', '-M', '--numstat', '-z']),
    git.raw(['diff', '--name-status', '-M', '-z']),
    git.raw(['diff', '--cached', '--name-status', '-M', '-z']),
  ]);

  const unstagedStats = parseNumStat(unstagedRaw);
  const stagedStats = parseNumStat(stagedRaw);
  const unstagedRenames = parseRenameMap(unstagedNameStatusRaw);
  const stagedRenames = parseRenameMap(stagedNameStatusRaw);
  const combinedStats = new Map<string, FileStats>();
  mergeStats(combinedStats, unstagedStats);
  mergeStats(combinedStats, stagedStats);

  const staged: GitWorkingTreeDetailsResponse['staged'] = [];
  const unstaged: GitWorkingTreeDetailsResponse['unstaged'] = [];
  const untracked: GitWorkingTreeDetailsResponse['untracked'] = [];
  const conflicted: GitWorkingTreeDetailsResponse['conflicted'] = [];
  const allPaths = new Set<string>();
  const conflictedSet = new Set(status.conflicted);

  const pushEntry = (
    list: GitWorkingTreeDetailsResponse['staged'],
    path: string,
    stats: FileStats,
    oldPath?: string,
  ) => {
    list.push({
      path,
      additions: stats.additions,
      deletions: stats.deletions,
      ...(oldPath ? { oldPath } : {}),
    });
    allPaths.add(path);
  };

  for (const file of status.files) {
    const path = file.path;
    if (conflictedSet.has(path)) {
      pushEntry(
        conflicted,
        path,
        combinedStats.get(path) ?? { additions: 0, deletions: 0 },
        unstagedRenames.get(path) ?? stagedRenames.get(path),
      );
      continue;
    }

    const isUntracked = file.index === '?' && file.working_dir === '?';
    if (isUntracked) {
      pushEntry(untracked, path, { additions: 0, deletions: 0 });
      continue;
    }

    const isStaged = file.index !== ' ' && file.index !== '?';
    const isUnstaged = file.working_dir !== ' ' && file.working_dir !== '?';

    if (isStaged) {
      pushEntry(staged, path, stagedStats.get(path) ?? { additions: 0, deletions: 0 }, stagedRenames.get(path));
    }
    if (isUnstaged) {
      pushEntry(unstaged, path, unstagedStats.get(path) ?? { additions: 0, deletions: 0 }, unstagedRenames.get(path));
    }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const stats of combinedStats.values()) {
    totalAdditions += stats.additions;
    totalDeletions += stats.deletions;
  }

  return {
    staged,
    unstaged,
    untracked,
    conflicted,
    stats: {
      totalAdditions,
      totalDeletions,
      changedFiles: allPaths.size,
    },
  };
}

/**
 * Get working directory status.
 * @param git - SimpleGit instance
 * @returns Status arrays
 */
export async function getStatus(git: SimpleGit): Promise<GitStatusResponse> {
  const status = await git.status();
  return {
    staged: status.staged,
    modified: status.modified,
    untracked: status.not_added,
    conflicted: status.conflicted,
  };
}
