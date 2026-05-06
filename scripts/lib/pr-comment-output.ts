/** Minimal rendered file-comment shape. */
interface RenderableFileComment {
  /** File path relative to the repo root. */
  path: string;
  /** End line number of the anchor. */
  line: number;
  /** Start line for multi-line comments. */
  startLine: number | null;
  /** Comment author. */
  author: string;
  /** Rendered body text. */
  body: string;
  /** Parent comment id for replies. */
  inReplyToId: number | null;
}

/** Minimal rendered review-body shape. */
interface RenderableReviewBody {
  /** Review state. */
  state: string;
  /** Review author. */
  author: string;
  /** Rendered body text. */
  body: string;
}

/** Minimal rendered issue-comment shape. */
interface RenderableIssueComment {
  /** Comment author. */
  author: string;
  /** Rendered body text. */
  body: string;
}

/** Minimal rendered CI check shape. */
interface RenderableCiCheck {
  /** Job name. */
  jobName: string;
  /** Check conclusion. */
  conclusion: string;
  /** Parent workflow name. */
  workflowName: string;
  /** Name of the failed step. */
  failedStep: string | null;
  /** Link to the job run. */
  detailsUrl: string;
}

/** Poll mode for workflow reminders. */
export interface ReviewWorkflowMode {
  /** Whether the run only shows previously unseen entries. */
  onlyNew: boolean;
  /** Whether the run waited in bounded polling mode. */
  timedPoll: boolean;
}

/**
 * Render grouped file comments, PR review bodies, issue comments, and CI checks to stdout.
 * @param reviewBodies - PR review bodies to print
 * @param fileComments - Inline file comments to print
 * @param issueComments - PR timeline issue comments to print
 * @param ciChecks - Failed CI check runs to print
 */
export function renderReviewEntries(
  reviewBodies: RenderableReviewBody[],
  fileComments: RenderableFileComment[],
  issueComments: RenderableIssueComment[] = [],
  ciChecks: RenderableCiCheck[] = [],
): void {
  if (ciChecks.length > 0) {
    console.info('\n── CI check results ────────────────────────────────────────────────');
    for (const check of ciChecks) {
      console.info(`\n  [${check.conclusion.toUpperCase()}] ${check.jobName} (${check.workflowName})`);
      if (check.failedStep && check.failedStep !== check.jobName) {
        console.info(`    Failed step: ${check.failedStep}`);
      }
      if (check.detailsUrl) {
        console.info(`    ${check.detailsUrl}`);
      }
    }
  }

  if (reviewBodies.length > 0) {
    console.info('\n── PR review comments ───────────────────────────────────────────────');
    for (const review of reviewBodies) {
      console.info(`\n  [${review.state}] @${review.author}:`);
      for (const line of review.body.split('\n')) {
        console.info(`    ${line}`);
      }
    }
  }

  if (issueComments.length > 0) {
    console.info('\n── PR timeline comments ─────────────────────────────────────────────');
    for (const comment of issueComments) {
      console.info(`\n  [COMMENT] @${comment.author}:`);
      for (const line of comment.body.split('\n')) {
        console.info(`    ${line}`);
      }
    }
  }

  if (fileComments.length === 0) {
    return;
  }

  const grouped = groupByFile(fileComments);
  for (const [filePath, comments] of grouped) {
    console.info(`\n── ${filePath} ${'─'.repeat(Math.max(0, 60 - filePath.length))}`);
    for (const comment of comments) {
      const prefix = comment.inReplyToId ? '  ↳ ' : '  ';
      console.info(`${prefix}[L${formatLineRange(comment)}] @${comment.author}:`);
      for (const line of comment.body.split('\n')) {
        console.info(`${prefix}  ${line}`);
      }
      console.info();
    }
  }
}

/**
 * Print a batch separator for watch mode with the current timestamp.
 * @param batchSize - Number of new findings in this batch
 */
export function renderWatchBatchHeader(batchSize: number): void {
  const timestamp = new Date().toISOString();
  console.info(`\n──── new findings (${timestamp}) — ${batchSize} entries ────────────────────────────`);
}

/**
 * Print the next required workflow step for the current polling mode.
 * @param mode - Current collector mode
 * @param hasFindings - Whether actionable findings were returned
 */
export function renderWorkflowReminder(mode: ReviewWorkflowMode, hasFindings: boolean): void {
  if (hasFindings) {
    console.info('\nNext step: add these items to the active task list before triage.');
    console.info('After fixing valid items, validating, and pushing, you MUST run this poll loop again.');
    return;
  }

  if (!mode.onlyNew) {
    return;
  }

  if (mode.timedPoll) {
    console.info('\nNo new actionable comments arrived during the timeout window.');
    console.info('This satisfies the current post-push review-observation round.');
    return;
  }

  console.info('\nThis was a one-shot guard only.');
  console.info('After your next clean push, you MUST run: tsx scripts/pr-comments.ts --new --timeout 20 <pr-url>');
}

/**
 * Format a line range string for display.
 * @param comment - File comment
 * @returns Formatted line reference
 */
function formatLineRange(comment: RenderableFileComment): string {
  if (comment.startLine && comment.startLine !== comment.line) {
    return `${comment.startLine}-${comment.line}`;
  }
  return String(comment.line);
}

/**
 * Group inline comments by file path, preserving order.
 * @param comments - Flat list of file comments
 * @returns Map of file path to comments
 */
function groupByFile(comments: RenderableFileComment[]): Map<string, RenderableFileComment[]> {
  const grouped = new Map<string, RenderableFileComment[]>();
  for (const comment of comments) {
    const list = grouped.get(comment.path);
    if (list) {
      list.push(comment);
      continue;
    }
    grouped.set(comment.path, [comment]);
  }
  return grouped;
}
