import type { ICapabilityProvider } from '../../capability/types.js';
import type {
  VCSRepository,
  VCSPullRequest,
  VCSPullRequestDetail,
  VCSCheckRun,
  VCSCommitStatus,
  VCSReviewComment,
} from './schemas/index.js';

/**
 * Options for creating a pull request.
 *
 * Phase 2 seam for PR creation functionality.
 */
export interface CreatePROptions {
  /** PR title */
  title: string;
  /** PR description body */
  body: string;
  /** Source branch */
  branch: string;
  /** Target branch */
  baseBranch: string;
  /** Whether to create as draft */
  draft?: boolean;
  /** Labels to apply */
  labels?: string[];
  /** Reviewers to request */
  reviewers?: string[];
}

/**
 * Options for merging a pull request.
 *
 * Phase 2 seam for PR merge functionality.
 */
export interface MergeOptions {
  /** Merge method to use */
  method?: 'merge' | 'squash' | 'rebase';
  /** Commit title for the merge */
  commitTitle?: string;
  /** Commit message for the merge */
  commitMessage?: string;
}

/**
 * VCS provider capability for source control platform integration.
 *
 * Enables GitHub, GitLab, Bitbucket, and other version control systems
 * to be pluggable providers of VCS functionality.
 *
 * This interface defines both the core Phase 1 methods and
 * Phase 2 optional extension seams for write operations.
 * @example
 * ```typescript
 * class GitHubVCSProvider implements IVCSProvider {
 *   readonly id = 'github-vcs';
 *   readonly displayName = 'GitHub';
 *   readonly capabilityId = 'vcs';
 *
 *   async getRepository(repoPath: string) {
 *     // Detect GitHub repo and return metadata
 *   }
 *
 *   async getPullRequests(repoPath: string, branch: string) {
 *     // Fetch PRs via GitHub API
 *   }
 *
 *   // Phase 2: Optional write operations
 *   async createPullRequest?(repoPath: string, options: CreatePROptions) {
 *     // Create PR via GitHub API
 *   }
 * }
 * ```
 */
export interface IVCSProvider extends ICapabilityProvider {
  /** Capability identifier - must be 'vcs' */
  readonly capabilityId: 'vcs';

  // === Repository Context ===

  /**
   * Get repository metadata for a local filesystem path.
   *
   * Detects if the given path is a VCS repository and returns
   * metadata about the remote repository (provider, owner, repo name, etc.).
   * @param repoPath - Local filesystem path to the repository
   * @returns Repository metadata, or null if not a VCS repository
   */
  getRepository(repoPath: string): Promise<VCSRepository | null>;

  // === Pull Requests ===

  /**
   * List pull requests for a repository branch.
   *
   * Returns summary information for PRs, suitable for list views.
   * @param repoPath - Local filesystem path to the repository
   * @param branch - Branch name to filter by (empty for all branches)
   * @returns Array of pull request summaries
   */
  getPullRequests(repoPath: string, branch: string): Promise<VCSPullRequest[]>;

  /**
   * Get detailed information about a specific pull request.
   *
   * Returns full PR details including reviews, labels, and assignees.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @returns Detailed pull request information
   */
  getPullRequest(repoPath: string, prNumber: number): Promise<VCSPullRequestDetail>;

  /**
   * Get open PRs that have changes affecting a specific file.
   * @param repoPath - Local filesystem path to the repository
   * @param filePath - Path to file relative to repo root
   * @returns Array of pull requests affecting the file
   */
  getPRsForFile(repoPath: string, filePath: string): Promise<VCSPullRequest[]>;

  // === Checks ===

  /**
   * Get CI/CD check runs for a commit.
   *
   * Returns the status of CI/CD workflows and checks for a given commit.
   * @param repoPath - Local filesystem path to the repository
   * @param commitSha - Commit SHA to get checks for
   * @returns Array of check runs
   */
  getChecks(repoPath: string, commitSha: string): Promise<VCSCheckRun[]>;

  /**
   * Get commit statuses for a commit (legacy status API).
   *
   * Returns statuses reported via the commit status API (e.g., CodeRabbit).
   * Distinct from check runs which come from GitHub Actions / Apps.
   * @param repoPath - Local filesystem path to the repository
   * @param commitSha - Commit SHA to get statuses for
   * @returns Array of commit statuses
   */
  getStatuses(repoPath: string, commitSha: string): Promise<VCSCommitStatus[]>;

  // === Review Comments ===

  /**
   * Get review comments for a pull request.
   *
   * Returns both inline code comments and general PR comments.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @returns Array of review comments
   */
  getReviewComments(repoPath: string, prNumber: number): Promise<VCSReviewComment[]>;

  // === Phase 2 Seams (Optional Write Operations) ===

  /**
   * Create a new pull request (Phase 2).
   *
   * Optional method for providers that support PR creation.
   * @param repoPath - Local filesystem path to the repository
   * @param options - PR creation options
   * @returns Created pull request information
   */
  createPullRequest?(repoPath: string, options: CreatePROptions): Promise<VCSPullRequest>;

  /**
   * Post a comment on a pull request (Phase 2).
   *
   * Optional method for providers that support posting comments.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @param body - Comment body text
   * @returns Created comment information
   */
  postComment?(repoPath: string, prNumber: number, body: string): Promise<VCSReviewComment>;

  /**
   * Request reviews from users for a pull request (Phase 2).
   *
   * Optional method for providers that support review requests.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @param reviewers - Usernames to request reviews from
   */
  requestReview?(repoPath: string, prNumber: number, reviewers: string[]): Promise<void>;

  /**
   * Merge a pull request (Phase 2).
   *
   * Optional method for providers that support PR merging.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @param options - Merge options
   */
  mergePullRequest?(repoPath: string, prNumber: number, options?: MergeOptions): Promise<void>;

  // === Phase 2: Comment Write Operations ===

  /**
   * Reply to an existing review comment (Phase 2).
   *
   * Optional method for providers that support comment replies.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @param commentId - ID of the comment to reply to
   * @param body - Reply body text
   * @returns Created reply comment
   */
  replyToComment?(repoPath: string, prNumber: number, commentId: number, body: string): Promise<VCSReviewComment>;

  /**
   * Post a new inline comment on a file:line (Phase 2).
   *
   * Optional method for providers that support inline code comments.
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @param path - File path relative to repo root
   * @param line - Line number (1-based)
   * @param commitId - Commit SHA the comment refers to
   * @param body - Comment body text
   * @param side - Which side of diff (LEFT=base, RIGHT=head)
   * @returns Created comment
   */
  createReviewComment?(
    repoPath: string,
    prNumber: number,
    path: string,
    line: number,
    commitId: string,
    body: string,
    side?: 'LEFT' | 'RIGHT',
  ): Promise<VCSReviewComment>;

  /**
   * Resolve a review thread (Phase 2).
   *
   * Optional method for providers that support thread resolution.
   * Uses GraphQL for GitHub (resolveReviewThread mutation).
   * @param repoPath - Local filesystem path to the repository
   * @param prNumber - Pull request number
   * @param threadId - Thread ID (GraphQL node ID)
   */
  resolveThread?(repoPath: string, prNumber: number, threadId: string): Promise<void>;

  /**
   * Get write capability level for current user (Phase 2).
   *
   * Optional method for checking user's write permissions.
   * @param repoPath - Local filesystem path to the repository
   * @returns Permission capability
   */
  getWriteCapability?(
    repoPath: string,
  ): Promise<{ canWrite: boolean; level: 'none' | 'read' | 'triage' | 'write' | 'maintain' | 'admin' }>;
}
