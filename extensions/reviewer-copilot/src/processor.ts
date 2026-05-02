import type {
  IReviewerProcessor,
  ProcessCommentsParams,
  ProcessReviewBodyParams,
  ReviewFinding,
  SuggestedChange,
  VCSReviewComment,
} from '@makaio/contracts';

/** Regex matching a fenced suggestion block (triple-backtick suggestion tag). */
const SUGGESTION_BLOCK_RE = /```suggestion\r?\n([\s\S]*?)```/;

/**
 * Extract the first suggestion block from a comment body.
 *
 * Returns the suggestion code content (without the fenced markers),
 * or undefined when no suggestion block is present.
 * @param body - Raw comment body text
 * @returns Suggestion code content or undefined
 */
function extractSuggestion(body: string): string | undefined {
  return SUGGESTION_BLOCK_RE.exec(body)?.[1];
}

/**
 * Strip all suggestion blocks from a comment body, returning the
 * prose description only.
 * @param body - Raw comment body text
 * @returns Body text with suggestion blocks removed, trimmed
 */
function stripSuggestionBlocks(body: string): string {
  return body.replace(/```suggestion[\s\S]*?```/g, '').trim();
}

/**
 * Map a single VCS review comment from Copilot to a {@link ReviewFinding}.
 *
 * Returns null for comments without a file path or for reply comments.
 * @param comment - A single VCS review comment authored by Copilot
 * @param params - Processing context carrying source ID and target
 * @returns A structured review finding, or null if the comment should be skipped
 */
function commentToFinding(comment: VCSReviewComment, params: ProcessCommentsParams): ReviewFinding | null {
  if (!comment.path || comment.path.trim().length === 0 || comment.inReplyToId !== null) {
    return null;
  }

  const suggestionContent = extractSuggestion(comment.body);
  const message = stripSuggestionBlocks(comment.body);

  const suggestedChanges: SuggestedChange[] =
    suggestionContent !== undefined ? [{ file: comment.path, oldCode: '', newCode: suggestionContent }] : [];

  const now = Date.now();
  const id =
    comment.threadId != null
      ? `${params.sourceId}:inline:${comment.id}`
      : `${params.sourceId}:inline:${comment.id}:${comment.path}:${comment.line ?? 0}`;

  const isResolved = Boolean(comment.isResolved);

  return {
    id,
    target: params.target,
    sourceId: params.sourceId,
    reviewer: 'copilot',
    origin: 'inline',
    threadId: comment.threadId ?? null,
    severity: 'minor',
    file: comment.path,
    startLine: comment.line ?? null,
    endLine: comment.line ?? null,
    message,
    agentPrompt: null,
    suggestedChanges,
    status: isResolved ? 'verified' : 'open',
    addressedBy: null,
    addressedAt: null,
    verifiedAt: isResolved ? now : null,
    dismissedReason: null,
    createdAt: new Date(comment.createdAt).getTime(),
    updatedAt: new Date(comment.updatedAt).getTime(),
    rawCommentId: comment.id,
  };
}

/**
 * Reviewer processor for Copilot-produced findings.
 *
 * Copilot does not signal severity levels — all findings are treated as
 * `'minor'`. Suggestion blocks are extracted as structured changes.
 *
 * Review bodies contain walkthrough tables and summary text but no
 * actionable per-line findings; {@link processReviewBody} always returns
 * an empty array.
 * @example
 * ```typescript
 * import { copilotProcessor } from '@makaio/reviewer-copilot';
 *
 * const findings = copilotProcessor.processComments({ sourceId, target, comments });
 * ```
 */
export const copilotProcessor: IReviewerProcessor = {
  id: 'copilot',
  displayName: 'GitHub Copilot Processor',
  capabilityId: 'reviewer-processor',
  reviewer: 'copilot',
  processorKey: 'makaio/copilot',
  priority: 0,
  botAuthors: ['copilot-pull-request-reviewer[bot]'],

  /**
   * Process inline Copilot review comments into findings.
   *
   * Skips reply comments and comments without a file path. Extracts
   * suggestion blocks as {@link SuggestedChange} entries.
   * @param params - Source ID, target, and raw VCS review comments
   * @returns Array of review findings
   */
  processComments(params: ProcessCommentsParams): ReviewFinding[] {
    const findings: ReviewFinding[] = [];
    for (const comment of params.comments) {
      const finding = commentToFinding(comment, params);
      if (finding !== null) findings.push(finding);
    }
    return findings;
  },

  /**
   * Process Copilot review bodies into findings.
   *
   * Copilot review bodies contain summary tables and walkthrough text
   * but no actionable per-line findings. Always returns an empty array.
   * @param _params - Unused review body parameters
   * @returns Empty array
   */
  processReviewBody(_params: ProcessReviewBodyParams): ReviewFinding[] {
    return [];
  },
};
