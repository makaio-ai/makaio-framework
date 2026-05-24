import { z } from 'zod';

/**
 * Base request schema with optional repoPath.
 * Defaults to process.cwd() if not specified.
 */
export const BaseRequestSchema = z.object({
  /** Repository path. Defaults to cwd if not specified. */
  repoPath: z.string().optional(),
});

// =============================================================================
// getRepoRoot - Get repository root directory
// =============================================================================

export const GitRepoRootRequestSchema = z.object({
  /** Path within the repository. Can be any subdirectory. */
  path: z.string(),
});
export type GitRepoRootRequest = z.infer<typeof GitRepoRootRequestSchema>;

export const GitRepoRootResponseSchema = z.object({
  /** Absolute path to repository root, or null if the path is not inside a git repository */
  root: z.string().nullable(),
});
export type GitRepoRootResponse = z.infer<typeof GitRepoRootResponseSchema>;

// =============================================================================
// getBranch - Get current branch info
// =============================================================================

export const GitBranchRequestSchema = BaseRequestSchema;
export type GitBranchRequest = z.infer<typeof GitBranchRequestSchema>;

export const GitBranchResponseSchema = z.object({
  /** Current branch name */
  current: z.string(),
  /** Whether HEAD is detached */
  isDetached: z.boolean(),
});
export type GitBranchResponse = z.infer<typeof GitBranchResponseSchema>;

// =============================================================================
// getCommit - Get commit info
// =============================================================================

export const GitCommitRequestSchema = BaseRequestSchema.extend({
  /** Git ref to get info for. Defaults to HEAD. */
  ref: z.string().optional(),
});
export type GitCommitRequest = z.infer<typeof GitCommitRequestSchema>;

export const GitCommitResponseSchema = z.object({
  /** Full commit hash */
  hash: z.string(),
  /** Commit message (first line) */
  message: z.string(),
  /** Author name */
  author: z.string(),
  /** Author email */
  email: z.string(),
  /** Commit date (ISO string) */
  date: z.string(),
});
export type GitCommitResponse = z.infer<typeof GitCommitResponseSchema>;

// =============================================================================
// getCommitDetails - Get commit changes (files and stats)
// =============================================================================

export const GitCommitDetailsRequestSchema = BaseRequestSchema.extend({
  /** Commit hash to get details for */
  hash: z.string(),
});
export type GitCommitDetailsRequest = z.infer<typeof GitCommitDetailsRequestSchema>;

export const GitFileChangeSchema = z.object({
  /** File path (new path for renames) */
  path: z.string(),
  /** Original path before rename (only present for renames) */
  oldPath: z.string().optional(),
  /** Status code: A (added), M (modified), D (deleted), R (renamed), etc. */
  status: z.string(),
  /** Additions count */
  additions: z.number(),
  /** Deletions count */
  deletions: z.number(),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

export const GitChangeStatsSchema = z.object({
  totalAdditions: z.number(),
  totalDeletions: z.number(),
  changedFiles: z.number(),
});
export type GitChangeStats = z.infer<typeof GitChangeStatsSchema>;

export const GitCommitDetailsResponseSchema = z.object({
  files: z.array(GitFileChangeSchema),
  stats: GitChangeStatsSchema,
});
export type GitCommitDetailsResponse = z.infer<typeof GitCommitDetailsResponseSchema>;

// =============================================================================
// getWorkingTreeDetails - Get working tree changes (files and stats)
// =============================================================================

export const GitWorkingTreeDetailsRequestSchema = BaseRequestSchema;
export type GitWorkingTreeDetailsRequest = z.infer<typeof GitWorkingTreeDetailsRequestSchema>;

export const GitWorkingTreeFileChangeSchema = z.object({
  /** File path */
  path: z.string(),
  /** Original path before rename (only present for renames) */
  oldPath: z.string().optional(),
  /** Additions count */
  additions: z.number(),
  /** Deletions count */
  deletions: z.number(),
});
export type GitWorkingTreeFileChange = z.infer<typeof GitWorkingTreeFileChangeSchema>;

export const GitWorkingTreeDetailsResponseSchema = z.object({
  staged: z.array(GitWorkingTreeFileChangeSchema),
  unstaged: z.array(GitWorkingTreeFileChangeSchema),
  untracked: z.array(GitWorkingTreeFileChangeSchema),
  conflicted: z.array(GitWorkingTreeFileChangeSchema),
  stats: GitChangeStatsSchema,
});
export type GitWorkingTreeDetailsResponse = z.infer<typeof GitWorkingTreeDetailsResponseSchema>;

// =============================================================================
// getStatus - Get working directory status
// =============================================================================

export const GitStatusRequestSchema = BaseRequestSchema;
export type GitStatusRequest = z.infer<typeof GitStatusRequestSchema>;

export const GitStatusResponseSchema = z.object({
  /** Files staged for commit */
  staged: z.array(z.string()),
  /** Modified files not staged */
  modified: z.array(z.string()),
  /** Untracked files */
  untracked: z.array(z.string()),
  /** Files with merge conflicts */
  conflicted: z.array(z.string()),
});
export type GitStatusResponse = z.infer<typeof GitStatusResponseSchema>;

// =============================================================================
// getWorktrees - List git worktrees
// =============================================================================

export const GitWorktreesRequestSchema = BaseRequestSchema;
export type GitWorktreesRequest = z.infer<typeof GitWorktreesRequestSchema>;

export const GitWorktreeInfoSchema = z.object({
  /** Worktree path */
  path: z.string(),
  /** Branch checked out in worktree */
  branch: z.string(),
  /** Current commit hash */
  commit: z.string(),
  /** Whether this is the main worktree */
  isMain: z.boolean(),
});
export type GitWorktreeInfo = z.infer<typeof GitWorktreeInfoSchema>;

export const GitWorktreesResponseSchema = z.object({
  worktrees: z.array(GitWorktreeInfoSchema),
});
export type GitWorktreesResponse = z.infer<typeof GitWorktreesResponseSchema>;

// =============================================================================
// getRemotes - List configured remotes
// =============================================================================

export const GitRemotesRequestSchema = BaseRequestSchema;
export type GitRemotesRequest = z.infer<typeof GitRemotesRequestSchema>;

export const GitRemoteSchema = z.object({
  /** Remote name (e.g., 'origin') */
  name: z.string(),
  /** Fetch URL */
  fetchUrl: z.string(),
  /** Push URL */
  pushUrl: z.string(),
});
export type GitRemote = z.infer<typeof GitRemoteSchema>;

export const GitRemotesResponseSchema = z.object({
  remotes: z.array(GitRemoteSchema),
});
export type GitRemotesResponse = z.infer<typeof GitRemotesResponseSchema>;

// =============================================================================
// getDefaultBranch - Get repository default branch
// =============================================================================

export const GitDefaultBranchRequestSchema = BaseRequestSchema;
export type GitDefaultBranchRequest = z.infer<typeof GitDefaultBranchRequestSchema>;

export const GitDefaultBranchResponseSchema = z.object({
  /** Default branch name (main, master, etc.) */
  branch: z.string(),
});
export type GitDefaultBranchResponse = z.infer<typeof GitDefaultBranchResponseSchema>;

// =============================================================================
// getLog - Get commit history with optional filters
// =============================================================================

export const GitLogFiltersSchema = z.object({
  /** Only commits reachable from these branches */
  branches: z.array(z.string()).optional(),
  /** Filtering mode for branches: 'all' (union) or 'specific' (unique to branches) */
  branchMode: z.enum(['all', 'specific']).optional(),
  /** Base branch for 'specific' mode (commits unique to branches excluding base) */
  baseBranch: z.string().optional(),
  /** Only commits touching these paths */
  paths: z.array(z.string()).optional(),
  /** Filter by author name/email */
  author: z.string().optional(),
  /** Commits after this date (ISO string) */
  since: z.string().optional(),
  /** Commits before this date (ISO string) */
  until: z.string().optional(),
  /** Search commit messages for this query */
  searchQuery: z.string().optional(),
  /** Worktree path to scope log to (uses worktree's HEAD as starting point) */
  selectedWorktree: z.string().optional(),
});
export type GitLogFilters = z.infer<typeof GitLogFiltersSchema>;

export const GitLogRequestSchema = BaseRequestSchema.extend({
  /** Max commits to return. Defaults to 1000. */
  limit: z.number().min(1).max(10000).optional(),
  /** Starting ref. Defaults to HEAD. */
  ref: z.string().optional(),
  /** Optional filters */
  filters: GitLogFiltersSchema.optional(),
});
export type GitLogRequest = z.infer<typeof GitLogRequestSchema>;

export const GitLogCommitSchema = z.object({
  /** Full commit hash */
  hash: z.string(),
  /** Short commit hash */
  shortHash: z.string(),
  /** Commit message (first line) */
  message: z.string(),
  /** Author name */
  author: z.string(),
  /** Author email */
  email: z.string(),
  /** Commit date (ISO string) */
  date: z.string(),
  /** Parent commit hashes */
  parents: z.array(z.string()),
});
export type GitLogCommit = z.infer<typeof GitLogCommitSchema>;

export const GitRefsSchema = z.object({
  /** Local branches: name to hash */
  branches: z.record(z.string(), z.string()),
  /** Remote branches: name to hash */
  remoteBranches: z.record(z.string(), z.string()),
  /** Tags: name to hash */
  tags: z.record(z.string(), z.string()),
  /** Current HEAD hash */
  HEAD: z.string(),
});
export type GitRefs = z.infer<typeof GitRefsSchema>;

export const GitLogResponseSchema = z.object({
  /** Commit history */
  commits: z.array(GitLogCommitSchema),
  /** All refs in the repository */
  refs: GitRefsSchema,
  /** True if more commits exist beyond limit */
  truncated: z.boolean(),
});
export type GitLogResponse = z.infer<typeof GitLogResponseSchema>;

// =============================================================================
// getFileAtRevision - Get file content at a specific revision
// =============================================================================

export const GitFileAtRevisionRequestSchema = BaseRequestSchema.extend({
  /** File path relative to repository root */
  path: z.string(),
  /** Git ref (commit hash, branch, tag) */
  ref: z.string(),
});
export type GitFileAtRevisionRequest = z.infer<typeof GitFileAtRevisionRequestSchema>;

export const GitFileAtRevisionResponseSchema = z.object({
  /** File content (empty for binary files) */
  content: z.string(),
  /** True if file is binary */
  isBinary: z.boolean(),
});
export type GitFileAtRevisionResponse = z.infer<typeof GitFileAtRevisionResponseSchema>;

// =============================================================================
// getDiff - Get unified diff
// =============================================================================

export const GitDiffRequestSchema = BaseRequestSchema.extend({
  /** Git ref (commit hash, branch, tag) to diff against parent. If not provided, diffs working tree. */
  ref: z.string().optional(),
  staged: z.boolean().optional(),
  unified: z.number().int().min(0).max(10).optional(),
  paths: z.array(z.string()).optional(),
});
export type GitDiffRequest = z.infer<typeof GitDiffRequestSchema>;

export const GitDiffResponseSchema = z.object({
  diff: z.string(),
});
export type GitDiffResponse = z.infer<typeof GitDiffResponseSchema>;

// =============================================================================
// getBranchCommits - Get all commit hashes reachable from a branch
// =============================================================================

export const GetBranchCommitsRequestSchema = z.object({
  /** Branch name to get commits for */
  branchName: z.string(),
  /** Repository path. Defaults to cwd if not specified. */
  repoPath: z.string().optional(),
});
export type GetBranchCommitsRequest = z.infer<typeof GetBranchCommitsRequestSchema>;

export const GetBranchCommitsResponseSchema = z.object({
  /** Array of commit hashes (full SHA) reachable from the branch */
  commitHashes: z.array(z.string()),
});
export type GetBranchCommitsResponse = z.infer<typeof GetBranchCommitsResponseSchema>;

// =============================================================================
// switchWorktree - Switch to a different worktree
// =============================================================================

export const GitSwitchWorktreeRequestSchema = z.object({
  /** Repository path. Optional, defaults to cwd. */
  repoPath: z.string().optional(),
  /** Path to the worktree to switch to */
  worktreePath: z.string(),
});
export type GitSwitchWorktreeRequest = z.infer<typeof GitSwitchWorktreeRequestSchema>;

export const GitSwitchWorktreeResponseSchema = z.object({
  /** Whether the switch was successful */
  success: z.boolean(),
  /** Error message if switch failed */
  error: z.string().optional(),
});
export type GitSwitchWorktreeResponse = z.infer<typeof GitSwitchWorktreeResponseSchema>;

// getBlame - Get blame annotations for a file

/** Request to get blame annotations. */
export const GitBlameRequestSchema = z.object({
  /** Repository path (defaults to cwd if not provided) */
  repoPath: z.string().optional(),
  /** File path relative to repo root */
  path: z.string(),
  /** Git ref (commit hash, branch, tag). Defaults to HEAD. */
  ref: z.string().optional(),
});
export type GitBlameRequest = z.infer<typeof GitBlameRequestSchema>;

/** A single blame annotation for a contiguous line range. */
export const GitBlameLineSchema = z.object({
  /** Start line (1-based, inclusive) */
  startLine: z.number(),
  /** End line (1-based, inclusive) */
  endLine: z.number(),
  /** Short commit hash */
  shortHash: z.string(),
  /** Full commit hash */
  hash: z.string(),
  /** Commit author name */
  author: z.string(),
  /** ISO date string of the commit */
  date: z.string(),
  /** Commit message (first line) */
  message: z.string(),
});
export type GitBlameLine = z.infer<typeof GitBlameLineSchema>;

/** Response from blame query. */
export const GitBlameResponseSchema = z.object({
  /** File content (full text) */
  content: z.string(),
  /** Blame annotations per line range */
  lines: z.array(GitBlameLineSchema),
});
export type GitBlameResponse = z.infer<typeof GitBlameResponseSchema>;

// =============================================================================
// getFileAtCommit - Get file content at a specific commit (null if not present)
// =============================================================================

export const GitFileAtCommitRequestSchema = BaseRequestSchema.extend({
  /** File path relative to repository root */
  filePath: z.string(),
  /** Commit hash (full or abbreviated SHA) */
  commitHash: z.string(),
});
export type GitFileAtCommitRequest = z.infer<typeof GitFileAtCommitRequestSchema>;

export const GitFileAtCommitResponseSchema = z.object({
  /**
   * File content from `getFileAtCommit`.
   * Null means either the file did not exist at this commit OR the file is binary.
   * Check `isBinary` before treating null as "missing".
   */
  content: z.string().nullable(),
  /** True when the target file is binary (binary content is returned as null). */
  isBinary: z.boolean(),
});
export type GitFileAtCommitResponse = z.infer<typeof GitFileAtCommitResponseSchema>;

// =============================================================================
// getBlobHashAtCommit - Get the git blob hash for a file at a specific commit
// =============================================================================

export const GitBlobHashAtCommitRequestSchema = BaseRequestSchema.extend({
  /** File path relative to repository root */
  filePath: z.string(),
  /** Commit hash (full or abbreviated SHA) */
  commitHash: z.string(),
});
export type GitBlobHashAtCommitRequest = z.infer<typeof GitBlobHashAtCommitRequestSchema>;

export const GitBlobHashAtCommitResponseSchema = z.object({
  /**
   * Git blob object hash for the file at this commit, or null if the file
   * did not exist at this commit or the commit/repo is invalid.
   */
  blobHash: z.string().nullable(),
});
export type GitBlobHashAtCommitResponse = z.infer<typeof GitBlobHashAtCommitResponseSchema>;

// =============================================================================
// fingerprint - Compute content-aware fingerprint of repository state
// =============================================================================

/** Request to compute a content-aware fingerprint of repository state. */
export const GitFingerprintRequestSchema = z.object({
  /** Repository path */
  repoPath: z.string(),
  /** Glob patterns to include in fingerprint (empty array is treated as catch-all) */
  include: z.array(z.string()),
  /** Glob patterns to exclude from fingerprint */
  exclude: z.array(z.string()),
  /** Optional git worktree path */
  worktree: z.string().optional(),
});
export type GitFingerprintRequest = z.infer<typeof GitFingerprintRequestSchema>;

/** Response containing the computed fingerprint and metadata. */
export const GitFingerprintResponseSchema = z.object({
  /** SHA-256 hash of repository content (commitSHA + filtered diff + untracked hashes) */
  hash: z.string(),
  /** Current commit SHA (git rev-parse HEAD) */
  commitSha: z.string(),
  /** File paths that contributed to the hash */
  changedPaths: z.array(z.string()),
  /** ISO 8601 timestamp of computation */
  timestamp: z.string(),
});
export type GitFingerprintResponse = z.infer<typeof GitFingerprintResponseSchema>;
