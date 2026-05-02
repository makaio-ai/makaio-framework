/** Parsed PR coordinates extracted from a GitHub URL. */
export interface PrCoordinates {
  /** GitHub organization or user name. */
  owner: string;
  /** Repository name (without owner prefix). */
  repo: string;
  /** Numeric pull request identifier. */
  pullNumber: number;
}

/** Shared fields for all review output entries. */
export interface BaseReviewEntry {
  /** Stable GitHub-backed identifier for state tracking. */
  id: string;
  /** Entry kind. */
  kind: 'file' | 'review' | 'comment';
  /** GitHub login of the review author. */
  author: string;
  /** Body text after optional cleanup. */
  body: string;
  /** ISO 8601 timestamp when the entry was created/submitted. */
  createdAt: string;
}

/** Inline file-level review comment. */
export interface FileCommentEntry extends BaseReviewEntry {
  /** File comment discriminator. */
  kind: 'file';
  /** File path relative to the repository root. */
  path: string;
  /** End line number of the comment anchor (0 if unavailable). */
  line: number;
  /** Start line for multi-line comments, or `null` for single-line comments. */
  startLine: number | null;
  /** ID of the parent comment when this is a reply, or `null` for top-level comments. */
  inReplyToId: number | null;
}

/** PR-level review body without a file anchor. */
export interface ReviewBodyEntry extends BaseReviewEntry {
  /** Review summary discriminator. */
  kind: 'review';
  /** Review state (e.g. COMMENTED, CHANGES_REQUESTED). */
  state: string;
}

/** PR timeline issue comment (not a review or file-anchored comment). */
export interface IssueCommentEntry extends BaseReviewEntry {
  /** Issue comment discriminator. */
  kind: 'comment';
}

/** Review-only entry (excludes CI checks). */
export type CommentEntry = FileCommentEntry | ReviewBodyEntry | IssueCommentEntry;

/** CI check run that did not succeed. */
export interface CiCheckEntry {
  /** Stable identifier for state tracking. */
  id: string;
  /** CI check discriminator. */
  kind: 'ci';
  /** Job name as shown in the GitHub Actions UI. */
  jobName: string;
  /** Check conclusion (e.g. `failure`, `cancelled`, `timed_out`). */
  conclusion: string;
  /** Parent workflow name (e.g. `CI Gate`, `CI Full`). */
  workflowName: string;
  /** Name of the step that failed, or null when step details are unavailable. */
  failedStep: string | null;
  /** Direct link to the job run in the GitHub Actions UI. */
  detailsUrl: string;
  /** ISO 8601 timestamp when the check completed. */
  createdAt: string;
}

/** Unified output entry. */
export type ReviewEntry = CommentEntry | CiCheckEntry;

/** GraphQL response node for a single review comment. */
export interface GraphQLReviewComment {
  /** File path relative to the repository root. */
  path: string;
  /** End line number of the comment anchor. */
  line: number | null;
  /** Start line for multi-line comments. */
  startLine: number | null;
  /** Original line number before code changes (for outdated comments). */
  originalLine: number | null;
  /** Original start line before code changes (for outdated comments). */
  originalStartLine: number | null;
  /** Comment author information. */
  author: { login: string } | null;
  /** Comment body text. */
  body: string;
  /** ISO 8601 timestamp when the comment was created. */
  createdAt: string;
  /** Unique database identifier for this comment. */
  databaseId: number;
  /** Parent comment when this is a reply. */
  replyTo: { databaseId: number } | null;
}

/** GraphQL response node for a review thread. */
export interface GraphQLReviewThread {
  /** Whether the thread has been marked as resolved. */
  isResolved: boolean;
  /** Whether the thread refers to lines that have been modified. */
  isOutdated: boolean;
  /** Comments within this thread. */
  comments: {
    nodes: GraphQLReviewComment[];
  };
}

/** GraphQL response node for a pull request review. */
export interface GraphQLReview {
  /** Unique review identifier for state tracking. */
  databaseId: number | null;
  /** Review state. */
  state: string;
  /** Review body text. */
  body: string;
  /** Review author. */
  author: { login: string } | null;
  /** Submission time. */
  submittedAt: string | null;
}

/** GraphQL pagination information. */
export interface GraphQLPageInfo {
  /** Whether there are more pages to fetch. */
  hasNextPage: boolean;
  /** Cursor for the next page. */
  endCursor: string | null;
}

/** GraphQL response node for a PR issue comment. */
export interface GraphQLIssueComment {
  /** Unique database identifier for this comment. */
  databaseId: number;
  /** Comment author information. */
  author: { login: string } | null;
  /** Comment body text. */
  body: string;
  /** ISO 8601 timestamp when the comment was created. */
  createdAt: string;
}

/** GraphQL response for pull request review threads, reviews, and issue comments. */
export interface GraphQLPullRequestResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        pageInfo: GraphQLPageInfo;
        nodes: GraphQLReviewThread[];
      };
      reviews: {
        pageInfo: GraphQLPageInfo;
        nodes: GraphQLReview[];
      };
      comments: {
        pageInfo: GraphQLPageInfo;
        nodes: GraphQLIssueComment[];
      };
    };
  };
}

/** Filter options for fetching review feedback. */
export interface FetchReviewEntriesOptions {
  /** Include resolved threads (default: false). */
  includeResolved: boolean;
  /** Include outdated threads (default: false). */
  includeOutdated: boolean;
}

/** GraphQL cursors for the current paginated request. */
export interface ReviewPageCursors {
  /** Review-thread page cursor. */
  threadCursor: string | null;
  /** PR-review page cursor. */
  reviewCursor: string | null;
  /** Issue-comment page cursor. */
  commentCursor: string | null;
}
