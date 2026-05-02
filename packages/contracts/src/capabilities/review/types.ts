import type { ICapabilityProvider } from '../../capability/types.js';
import type { FindingTarget, ReviewFinding, ReviewIssueComment, ReviewSourceRateLimit } from './schemas.js';
import type { VCSReviewComment, VCSReview } from '../vcs/schemas/index.js';

/**
 * Parameters for triggering a review.
 */
export interface ReviewTriggerParams {
  /** Target PR/branch to review */
  target: FindingTarget;
  /** Source to trigger (optional, uses default) */
  sourceId?: string;
}

/**
 * Result of triggering a review.
 */
export interface ReviewTriggerResult {
  /** Whether the trigger was successful */
  triggered: boolean;
  /** Estimated delay before results are available */
  estimatedDelayMs?: number;
  /** Current rate limit state */
  rateLimit: ReviewSourceRateLimit | null;
}

/**
 * Parameters for fetching findings from a source.
 */
export interface FetchFindingsParams {
  /** Target PR/branch */
  target: FindingTarget;
}

/**
 * Execution context carrying VCS routing information.
 */
export interface ReviewRequestContext {
  /** Local repository path used only for VCS provider routing */
  repoPath: string;
  /** Target PR/branch */
  target: FindingTarget;
}

/**
 * Snapshot of raw data from a review source, before processing.
 */
export interface ReviewSourceSnapshot {
  /** Source that produced this snapshot */
  sourceId: string;
  /** Reviewer family */
  reviewer: string;
  /** Target PR/branch */
  target: FindingTarget;
  /** Inline and general review comments */
  comments: VCSReviewComment[];
  /** Review-level bodies */
  reviews: VCSReview[];
  /** Issue-level comments (e.g., from issue timeline) */
  issueComments?: ReviewIssueComment[];
  /** CLI tool output */
  cliOutput?: string;
  /** Raw body containing rate limit information */
  rateLimitBody?: string;
}

/**
 * Parameters for processing inline comments.
 */
export interface ProcessCommentsParams {
  /** Source that fetched the comments */
  sourceId: string;
  /** Target PR/branch */
  target: FindingTarget;
  /** Raw VCS review comments */
  comments: readonly VCSReviewComment[];
}

/**
 * Parameters for processing review bodies.
 */
export interface ProcessReviewBodyParams {
  /** Source that fetched the reviews */
  sourceId: string;
  /** Target PR/branch */
  target: FindingTarget;
  /** Raw VCS reviews */
  reviews: readonly VCSReview[];
}

/**
 * Parameters for processing issue comments.
 */
export interface ProcessIssueCommentsParams {
  /** Source that fetched the issue comments */
  sourceId: string;
  /** Target PR/branch */
  target: FindingTarget;
  /** Raw issue comments */
  issueComments: readonly ReviewIssueComment[];
}

/**
 * Parameters for processing CLI output.
 */
export interface ProcessCliOutputParams {
  /** Source that produced the output */
  sourceId: string;
  /** Target PR/branch */
  target: FindingTarget;
  /** Raw CLI output string */
  cliOutput: string;
}

/**
 * Review source capability provider.
 *
 * Sources handle source-specific I/O: VCS reads, CLI invocation, trigger
 * comments, and rate-limit metadata.
 */
export interface IReviewSource extends ICapabilityProvider {
  /** Must be 'review-source' */
  readonly capabilityId: 'review-source';
  /** Reviewer family this source feeds (e.g., 'coderabbit') */
  readonly reviewer: string;
  /** Preferred processor key for this source */
  readonly preferredProcessorKey?: string;
  /** Source capabilities */
  readonly capabilities: {
    canTrigger: boolean;
    canFetch: boolean;
    isPush: boolean;
  };
  /**
   * Trigger a review (e.g., post "\@coderabbitai review" comment).
   * @param params - Trigger parameters merged with VCS routing context
   * @returns Result indicating whether the trigger succeeded
   */
  trigger?(params: ReviewTriggerParams & ReviewRequestContext): Promise<ReviewTriggerResult>;
  /**
   * Fetch raw snapshot from the source.
   * @param params - Fetch parameters merged with VCS routing context
   * @returns Raw snapshot of source data before processing
   */
  fetchSnapshot?(params: FetchFindingsParams & ReviewRequestContext): Promise<ReviewSourceSnapshot>;
  /**
   * Get current rate limit state.
   * @returns Current rate limit or null if not applicable
   */
  getRateLimit?(): ReviewSourceRateLimit | null;
}

/**
 * Reviewer processor capability provider.
 *
 * Processors handle stateless transformation from raw source data to
 * ReviewFinding arrays. They must be pure transformation logic with no
 * I/O dependencies.
 */
export interface IReviewerProcessor extends ICapabilityProvider {
  /** Must be 'reviewer-processor' */
  readonly capabilityId: 'reviewer-processor';
  /** Reviewer family this processor handles */
  readonly reviewer: string;
  /** Unique processor key (e.g., 'makaio/coderabbit') */
  readonly processorKey: string;
  /** Priority for processor resolution (higher wins, default 0) */
  readonly priority?: number;
  /** Processor keys this one supersedes (diagnostic metadata) */
  readonly supersedes?: readonly string[];
  /** Bot usernames that produce content for this reviewer */
  readonly botAuthors: readonly string[];
  /**
   * Process inline review comments into findings.
   * @param params - Parameters containing source ID, target, and raw comments
   * @returns Array of review findings extracted from the comments
   */
  processComments(params: ProcessCommentsParams): ReviewFinding[];
  /**
   * Process review body content into findings.
   * @param params - Parameters containing source ID, target, and raw reviews
   * @returns Array of review findings extracted from the review bodies
   */
  processReviewBody(params: ProcessReviewBodyParams): ReviewFinding[];
  /**
   * Process issue-level comments into findings.
   * @param params - Parameters containing source ID, target, and raw issue comments
   * @returns Array of review findings extracted from the issue comments
   */
  processIssueComments?(params: ProcessIssueCommentsParams): ReviewFinding[];
  /**
   * Process CLI output into findings.
   * @param params - Parameters containing source ID, target, and raw CLI output
   * @returns Array of review findings extracted from the CLI output
   */
  processCliOutput?(params: ProcessCliOutputParams): ReviewFinding[];
  /**
   * Parse rate limit information from a body string.
   * @param body - Raw text body potentially containing rate limit information
   * @returns Parsed rate limit or null if none found
   */
  parseRateLimit?(body: string): ReviewSourceRateLimit | null;
  /**
   * Extract AI-optimized agent prompt from a comment body.
   * @param body - Raw comment body text
   * @returns Agent-optimized prompt string or undefined if not extractable
   */
  extractAgentPrompt?(body: string): string | undefined;
}
