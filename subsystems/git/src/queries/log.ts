/**
 * Git log queries.
 * @packageDocumentation
 */

import type { SimpleGit } from 'simple-git';
import type { GitLogCommit, GitLogFilters, GitLogResponse } from '../schemas.js';
import { getRefs } from './refs.js';

const DEFAULT_LOG_LIMIT = 1000;

/**
 * Build git log flags from filters (for git.raw()).
 * Excludes paths - use buildPathArgs() for pathspecs.
 * @param filters - Optional Git log filters
 * @returns Array of git log command flags (without pathspecs)
 */
function buildLogFlags(filters?: GitLogFilters): string[] {
  const flags: string[] = [];

  if (filters?.author) {
    flags.push(`--author=${filters.author}`);
  }
  if (filters?.since) {
    flags.push(`--since=${filters.since}`);
  }
  if (filters?.until) {
    flags.push(`--until=${filters.until}`);
  }
  if (filters?.searchQuery) {
    flags.push(`--grep=${filters.searchQuery}`);
  }

  return flags;
}

/**
 * Build pathspec arguments for git log.
 * Must be appended AFTER all revision arguments per git log usage:
 * git log [options] [revision-range] [[--] path...]
 * @param filters - Optional Git log filters
 * @returns Array of pathspec args (including -- terminator) or empty array
 */
function buildPathArgs(filters?: GitLogFilters): string[] {
  if (filters?.paths?.length) {
    return ['--', ...filters.paths];
  }
  return [];
}

/**
 * Parse raw git log output (null-delimited format).
 * @param output - Raw output from git log --format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%P
 * @returns Array of parsed commits
 */
function parseLogOutput(output: string): Array<Omit<GitLogCommit, 'parents'> & { parents: string[] }> {
  if (!output.trim()) return [];

  return output
    .trim()
    .split('\n')
    .map((line) => {
      const [hash, shortHash, message, author, email, date, parents] = line.split('\x00');

      return {
        hash,
        shortHash,
        message,
        author,
        email,
        date,
        parents: parents ? parents.split(' ') : [],
      };
    });
}

/**
 * Git log with branch filtering using git.raw() API.
 * Supports two modes: 'all' (union) and 'specific' (unique to branches).
 * @param git - SimpleGit instance
 * @param requestLimit - Maximum commits to fetch
 * @param filters - Git log filters including branches
 * @returns Git log response with filtered commits
 */
async function getLogWithBranches(
  git: SimpleGit,
  requestLimit: number,
  filters: GitLogFilters,
): Promise<GitLogResponse> {
  const branches = filters.branches ?? [];
  const mode = filters.branchMode ?? 'all';

  // Build git log arguments following git log usage:
  // git log [<options>] [<revision-range>] [[--] <path>...]
  // Use null byte delimiter (%x00) to safely handle commit messages with special chars
  // Note: %P gives full parent hashes
  const args = [
    'log',
    `--max-count=${requestLimit}`,
    '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%P',
    ...buildLogFlags(filters), // Flags like --author, --since, etc. (no paths)
  ];

  // Add branch/revision arguments
  if (mode === 'specific' && filters.baseBranch) {
    // Branch-specific: show unique commits
    // git log branchA branchB --not main
    args.push(...branches);
    args.push('--not', filters.baseBranch);
  } else {
    // All history: union of branches
    // git log branchA branchB
    args.push(...branches);
  }

  // Add pathspec arguments LAST (after all revision args)
  args.push(...buildPathArgs(filters));

  // Execute raw git command
  const output = await git.raw(args);

  // Parse output
  const commits = parseLogOutput(output);
  const refs = await getRefs(git);

  return {
    commits: commits.slice(0, requestLimit - 1),
    refs,
    truncated: commits.length >= requestLimit,
  };
}

/**
 * Git log with multiple path filters using git.raw() API.
 * @param git - SimpleGit instance
 * @param requestLimit - Maximum commits to fetch
 * @param ref - Optional starting ref
 * @param filters - Git log filters including paths
 * @returns Git log response with filtered commits
 */
async function getLogWithPaths(
  git: SimpleGit,
  requestLimit: number,
  ref: string | undefined,
  filters: GitLogFilters,
): Promise<GitLogResponse> {
  const args = [
    'log',
    `--max-count=${requestLimit}`,
    '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00%P',
    ...buildLogFlags(filters),
  ];

  if (ref) {
    // Use a single ref (not symmetric-difference syntax) to keep "starting ref" semantics.
    args.push(ref);
  }

  args.push(...buildPathArgs(filters));

  const output = await git.raw(args);
  const commits = parseLogOutput(output);
  const refs = await getRefs(git);

  return {
    commits: commits.slice(0, requestLimit - 1),
    refs,
    truncated: commits.length >= requestLimit,
  };
}

/**
 * Build log options for simple-git log() API.
 * @param filters - Optional filters
 * @returns Log options
 */
function buildLogOptions(filters?: GitLogFilters): Record<string, string> {
  const options: Record<string, string> = {};
  if (filters?.author) options['--author'] = filters.author;
  if (filters?.since) options['--since'] = filters.since;
  if (filters?.until) options['--until'] = filters.until;
  if (filters?.searchQuery) options['--grep'] = filters.searchQuery;
  return options;
}

/**
 * Get commit history with optional filters.
 * @param git - SimpleGit instance
 * @param limit - Max commits (default 1000)
 * @param ref - Starting ref
 * @param filters - Optional filters
 * @returns Commits, refs, and truncated flag
 */
export async function getLog(
  git: SimpleGit,
  limit?: number,
  ref?: string,
  filters?: GitLogFilters,
): Promise<GitLogResponse> {
  const actualLimit = limit ?? DEFAULT_LOG_LIMIT;
  const requestLimit = actualLimit + 1;

  // Branch filtering requires git.raw() API because SimpleGit's high-level
  // log() API doesn't support passing branches as positional arguments.
  if (filters?.branches?.length) {
    return getLogWithBranches(git, requestLimit, filters);
  }

  if ((filters?.paths?.length ?? 0) > 1) {
    return getLogWithPaths(git, requestLimit, ref, filters ?? {});
  }

  const result = await git.log({
    maxCount: requestLimit,
    format: {
      hash: '%H',
      shortHash: '%h',
      message: '%s',
      author: '%an',
      email: '%ae',
      date: '%aI',
      parents: '%P',
    },
    ...(ref ? { from: ref } : {}),
    ...buildLogOptions(filters),
    ...(filters?.paths?.length === 1 ? { file: filters.paths[0] } : {}),
  });

  const truncated = result.all.length > actualLimit;
  const commits = result.all.slice(0, actualLimit).map((commit) => ({
    hash: commit.hash,
    shortHash: commit.shortHash,
    message: commit.message,
    author: commit.author,
    email: commit.email,
    date: commit.date,
    parents: commit.parents ? commit.parents.split(' ').filter(Boolean) : [],
  }));

  const refs = await getRefs(git);

  return { commits, refs, truncated };
}
