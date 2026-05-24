/**
 * Git commit details queries.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { GitCommitDetailsResponse } from '../schemas.js';

interface DiffTreePlan {
  /** Base diff-tree arguments (without format flags and refs). */
  args: string[];
  /** Whether the target commit is a root commit. */
  isRoot: boolean;
}

/**
 * Split NUL-delimited git output, dropping trailing empty segments.
 * @param raw - Raw output string
 * @returns Parsed NUL-delimited records
 */
function splitNulRecords(raw: string): string[] {
  return raw.split('\0').filter((record) => record.length > 0);
}

/**
 * Parse `--name-status -z` output into a map keyed by new/current path.
 * @param raw - Raw `--name-status -z` output
 * @returns Map of path to status metadata
 */
function parseNameStatus(raw: string): Map<string, { status: string; oldPath?: string }> {
  const statusMap = new Map<string, { status: string; oldPath?: string }>();
  const records = splitNulRecords(raw);

  for (let index = 0; index < records.length; index += 1) {
    const statusToken = records[index];
    if (!statusToken) continue;

    const status = statusToken[0];
    if (!status) continue;

    if (status === 'R' || status === 'C') {
      const oldPath = records[index + 1];
      const newPath = records[index + 2];
      if (oldPath && newPath) {
        statusMap.set(newPath, { status, oldPath });
      }
      index += 2;
      continue;
    }

    const path = records[index + 1];
    if (path) {
      statusMap.set(path, { status });
    }
    index += 1;
  }

  return statusMap;
}

/**
 * Parse `--numstat -z` output into changed file rows.
 * @param raw - Raw `--numstat -z` output
 * @returns Parsed per-file additions/deletions with optional oldPath for renames
 */
function parseNumStat(raw: string): Array<{ path: string; additions: number; deletions: number; oldPath?: string }> {
  const records = splitNulRecords(raw);
  const parsed: Array<{ path: string; additions: number; deletions: number; oldPath?: string }> = [];

  for (let index = 0; index < records.length; index += 1) {
    const header = records[index];
    if (!header) continue;

    const [adds = '', dels = '', pathToken = ''] = header.split('\t');
    if (!adds || !dels) continue;

    const additions = adds === '-' ? 0 : parseInt(adds, 10) || 0;
    const deletions = dels === '-' ? 0 : parseInt(dels, 10) || 0;

    if (pathToken.length > 0) {
      parsed.push({ path: pathToken, additions, deletions });
      continue;
    }

    const oldPath = records[index + 1];
    const newPath = records[index + 2];
    if (!newPath) continue;
    parsed.push({
      path: newPath,
      additions,
      deletions,
      ...(oldPath ? { oldPath } : {}),
    });
    index += 2;
  }

  return parsed;
}

/**
 * Determine the `diff-tree` arguments to compare a commit against its first
 * parent, handling both root commits and merge commits correctly.
 *
 * For the root commit (no parent), git requires `--root` to produce any
 * output. For every other commit — including merge commits with multiple
 * parents — explicitly specifying `<parent> <commit>` diffs only against the
 * first parent, which is the standard behaviour in UIs like GitHub.
 * @param git - SimpleGit instance
 * @param hash - Commit hash to inspect
 * @returns Diff tree execution plan for this commit
 */
async function buildDiffTreeArgs(git: SimpleGit, hash: string): Promise<DiffTreePlan> {
  // `rev-parse --verify --quiet` writes the resolved ref to stdout on success
  // (exit 0) and writes nothing on failure (exit 1). Because stderr is empty
  // when using --quiet, simple-git does not throw on failure — instead it
  // resolves with an empty string. Checking the trimmed output is therefore
  // the reliable way to distinguish a root commit from a commit with a parent.
  const parentRef = (await git.raw(['rev-parse', '--verify', '--quiet', `${hash}^1`])).trim();

  if (parentRef) {
    // Has at least one parent — diff against first parent explicitly.
    // This also handles merge commits (>1 parent) correctly.
    return { args: ['diff-tree', '-M', '-r', '--no-commit-id'], isRoot: false };
  }

  // No parent resolved: this is the root commit, use --root.
  return { args: ['diff-tree', '--root', '-M', '-r', '--no-commit-id'], isRoot: true };
}

/**
 * Get commit changes (files and stats).
 *
 * For merge commits, diffs against the first parent — consistent with how
 * tools such as GitHub present merge commit changes.
 * @param git - SimpleGit instance
 * @param hash - Commit hash
 * @returns Files list and aggregate stats
 */
export async function getCommitDetails(git: SimpleGit, hash: string): Promise<GitCommitDetailsResponse> {
  const files: GitCommitDetailsResponse['files'] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  const plan = await buildDiffTreeArgs(git, hash);

  // For non-root commits the two-tree form needs explicit parent and child refs.
  const treeRefs = plan.isRoot ? [hash] : [`${hash}^1`, hash];

  const [nameStatusRaw, numStatRaw] = await Promise.all([
    git.raw([...plan.args, '--name-status', '-z', ...treeRefs]),
    git.raw([...plan.args, '--numstat', '-z', ...treeRefs]),
  ]);

  const statusMap = parseNameStatus(nameStatusRaw);
  const numStatEntries = parseNumStat(numStatRaw);

  for (const entry of numStatEntries) {
    const info = statusMap.get(entry.path);
    const status = info?.status ?? 'M';
    const oldPath = info?.oldPath ?? entry.oldPath;

    totalAdditions += entry.additions;
    totalDeletions += entry.deletions;

    files.push({
      path: entry.path,
      ...(oldPath && { oldPath }),
      status,
      additions: entry.additions,
      deletions: entry.deletions,
    });
  }

  return {
    files,
    stats: {
      totalAdditions,
      totalDeletions,
      changedFiles: files.length,
    },
  };
}
