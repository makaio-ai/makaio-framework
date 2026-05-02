import type {
  CheckRunDetail,
  ChecksSummary,
  FindingsSummary,
  LabelInfo,
  LabelSemantic,
  ReadinessAssessment,
  ReviewerState,
  ReviewsSummary,
  VCSCheckRun,
  VCSCommitStatus,
  VCSPullRequestDetail,
  VCSReview,
  ReviewFinding,
} from '@makaio/contracts';

// ---------------------------------------------------------------------------
// Checks summary
// ---------------------------------------------------------------------------

/**
 * Map a check-run conclusion to a `CheckRunDetail` entry.
 * @param run - Completed check run with a failing conclusion
 * @returns Detail entry with source tagged as `'check-run'`
 */
function toCheckRunDetail(run: VCSCheckRun): CheckRunDetail {
  return {
    id: run.id,
    name: run.name,
    workflowName: run.workflowName ?? '',
    conclusion: run.conclusion ?? 'failure',
    failedStep: null,
    detailsUrl: run.url,
    completedAt: run.completedAt,
    source: 'check-run',
  };
}

/**
 * Map a commit status to a `CheckRunDetail` entry.
 * @param status - Commit status with a failing state
 * @returns Detail entry with source tagged as `'commit-status'`
 */
function toCommitStatusDetail(status: VCSCommitStatus): CheckRunDetail {
  return {
    id: status.id,
    name: status.context,
    workflowName: '',
    conclusion: status.state,
    failedStep: null,
    detailsUrl: status.targetUrl,
    completedAt: status.updatedAt,
    source: 'commit-status',
  };
}

/**
 * Accumulate counts and failed-check details for a single check run.
 * @param run - Check run to classify
 * @param counts - Mutable counters to update in place
 * @param failedChecks - Array to append failed-check details to
 */
function accumulateCheckRun(
  run: VCSCheckRun,
  counts: { passed: number; failed: number; pending: number; skipped: number },
  failedChecks: CheckRunDetail[],
): void {
  if (run.status !== 'completed') {
    counts.pending++;
    return;
  }
  switch (run.conclusion) {
    case 'success':
    case 'neutral':
      counts.passed++;
      break;
    case 'skipped':
    case 'cancelled':
      counts.skipped++;
      break;
    case 'failure':
    case 'timed_out':
    case 'action_required':
      counts.failed++;
      failedChecks.push(toCheckRunDetail(run));
      break;
    default:
      // null conclusion on a 'completed' run is treated as passed
      counts.passed++;
  }
}

/**
 * Accumulate counts and failed-check details for a single commit status.
 * @param status - Commit status to classify
 * @param counts - Mutable counters to update in place
 * @param failedChecks - Array to append failed-check details to
 */
function accumulateCommitStatus(
  status: VCSCommitStatus,
  counts: { passed: number; failed: number; pending: number },
  failedChecks: CheckRunDetail[],
): void {
  switch (status.state) {
    case 'success':
      counts.passed++;
      break;
    case 'pending':
      counts.pending++;
      break;
    case 'failure':
    case 'error':
      counts.failed++;
      failedChecks.push(toCommitStatusDetail(status));
      break;
  }
}

/**
 * Merge GitHub check runs and legacy commit statuses into a unified summary.
 * @param checkRuns - Check runs from `vcs.checks.get`
 * @param statuses - Commit statuses from `vcs.statuses.get`
 * @returns Unified checks summary
 */
export function computeChecksSummary(checkRuns: VCSCheckRun[], statuses: VCSCommitStatus[]): ChecksSummary {
  const counts = { passed: 0, failed: 0, pending: 0, skipped: 0 };
  const failedChecks: CheckRunDetail[] = [];

  for (const run of checkRuns) {
    accumulateCheckRun(run, counts, failedChecks);
  }
  for (const status of statuses) {
    accumulateCommitStatus(status, counts, failedChecks);
  }

  const { passed, failed, pending, skipped } = counts;
  const total = passed + failed + pending + skipped;

  let status: ChecksSummary['status'];
  if (failed > 0 && pending === 0) {
    status = 'failing';
  } else if (failed > 0) {
    status = 'mixed';
  } else if (pending > 0) {
    status = 'pending';
  } else {
    status = 'passing';
  }

  const summary =
    total === 0
      ? 'No checks'
      : `${passed}/${total} passing${failed > 0 ? `, ${failed} failing` : ''}${pending > 0 ? `, ${pending} pending` : ''}`;

  return { status, total, passed, failed, pending, skipped, failedChecks, summary };
}

// ---------------------------------------------------------------------------
// Reviews summary
// ---------------------------------------------------------------------------

/**
 * Aggregate PR reviews, taking the latest state per reviewer.
 * @param reviews - Reviews from `vcs.pr.get`
 * @returns Reviews summary with per-reviewer state
 */
export function computeReviewsSummary(reviews: VCSReview[]): ReviewsSummary {
  const latestByReviewer = new Map<string, VCSReview>();

  for (const review of reviews) {
    const existing = latestByReviewer.get(review.author);
    if (!existing) {
      latestByReviewer.set(review.author, review);
      continue;
    }
    const existingTs = existing.submittedAt ? new Date(existing.submittedAt).getTime() : 0;
    const candidateTs = review.submittedAt ? new Date(review.submittedAt).getTime() : 0;
    if (candidateTs >= existingTs) {
      latestByReviewer.set(review.author, review);
    }
  }

  let approvals = 0;
  let changesRequested = 0;
  let commented = 0;
  const reviewers: ReviewerState[] = [];

  for (const [reviewer, review] of latestByReviewer) {
    reviewers.push({ reviewer, state: review.state, submittedAt: review.submittedAt });
    switch (review.state) {
      case 'APPROVED':
        approvals++;
        break;
      case 'CHANGES_REQUESTED':
        changesRequested++;
        break;
      case 'COMMENTED':
        commented++;
        break;
      // PENDING and DISMISSED do not affect counts
    }
  }

  let status: ReviewsSummary['status'];
  if (changesRequested > 0) {
    status = 'changes-requested';
  } else if (approvals === 0) {
    status = 'pending';
  } else {
    status = 'approved';
  }

  const summary =
    reviewers.length === 0
      ? 'No reviews'
      : `${approvals} approval${approvals !== 1 ? 's' : ''}` +
        (changesRequested > 0 ? `, ${changesRequested} changes requested` : '');

  return { status, approvals, changesRequested, commented, reviewers, summary };
}

// ---------------------------------------------------------------------------
// Findings summary
// ---------------------------------------------------------------------------

/**
 * Summarise review findings by status and severity.
 * @param findings - Findings from `review.findings.list`
 * @returns Findings summary
 */
export function computeFindingsSummary(findings: ReviewFinding[]): FindingsSummary {
  let open = 0;
  let addressed = 0;
  let verified = 0;
  let dismissed = 0;
  const openBySeverity = { critical: 0, major: 0, minor: 0, nitpick: 0 };

  for (const finding of findings) {
    switch (finding.status) {
      case 'open':
        open++;
        openBySeverity[finding.severity]++;
        break;
      case 'addressed':
        addressed++;
        break;
      case 'verified':
        verified++;
        break;
      case 'dismissed':
      case 'deferred':
        dismissed++;
        break;
    }
  }

  const total = findings.length;
  const summary =
    total === 0
      ? 'No findings'
      : open === 0
        ? `${total} findings, all resolved`
        : `${open} open finding${open !== 1 ? 's' : ''} (${openBySeverity.critical} critical, ${openBySeverity.major} major)`;

  return { total, open, addressed, verified, dismissed, openBySeverity, summary };
}

// ---------------------------------------------------------------------------
// Label classification
// ---------------------------------------------------------------------------

/** Substrings that indicate each semantic category. Evaluated in order. */
const LABEL_SUBSTRING_RULES: ReadonlyArray<[ReadonlyArray<string>, LabelSemantic]> = [
  [['priority', 'urgent'], 'priority'],
  [['wip', 'ready', 'blocked', 'in-progress'], 'status'],
  [['bug', 'feature', 'enhancement', 'chore'], 'type'],
  [['size/'], 'size'],
  [['review', 'approved', 'changes'], 'review'],
  [['auto', 'bot', 'automation'], 'automation'],
];

/** Exact label strings that map to a semantic category (checked after substrings). */
const LABEL_EXACT_RULES: ReadonlyArray<[string, LabelSemantic]> = [
  ['xs', 'size'],
  ['xl', 'size'],
  ['ci', 'automation'],
];

/**
 * Map a label name to its semantic category using simple heuristics.
 * @param name - Label name (matched case-insensitively)
 * @returns Semantic category, or `null` when unrecognised
 */
export function classifyLabel(name: string): LabelSemantic | null {
  const lower = name.toLowerCase();

  for (const [substrings, semantic] of LABEL_SUBSTRING_RULES) {
    if (substrings.some((s) => lower.includes(s))) return semantic;
  }
  // Priority labels may use p0–p4 shorthand not caught by substring match
  if (/\bp[0-4]\b/.test(lower)) return 'priority';

  for (const [exact, semantic] of LABEL_EXACT_RULES) {
    if (lower === exact) return semantic;
  }

  return null;
}

/**
 * Apply label semantic classification to a list of raw label strings.
 * @param labels - Raw label names from the VCS PR response
 * @returns Labelled list with semantic annotation
 */
export function classifyLabels(labels: string[]): LabelInfo[] {
  return labels.map((name) => ({ name, semantic: classifyLabel(name) }));
}

// ---------------------------------------------------------------------------
// Readiness assessment
// ---------------------------------------------------------------------------

/**
 * Compute the readiness assessment from all aggregated sub-states.
 * @param pr - PR metadata subset (state, draft, mergeable)
 * @param checks - Checks summary
 * @param reviews - Reviews summary
 * @param findings - Findings summary
 * @returns Readiness assessment with blockers and warnings
 */
export function computeReadiness(
  pr: Pick<VCSPullRequestDetail, 'state' | 'draft' | 'mergeable'>,
  checks: ChecksSummary,
  reviews: ReviewsSummary,
  findings: FindingsSummary,
): ReadinessAssessment {
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (pr.state !== 'open') blockers.push(`PR is ${pr.state}`);
  if (pr.draft) blockers.push('PR is a draft');
  if (pr.mergeable === false) blockers.push('Merge conflicts detected');

  if (checks.status === 'failing') {
    const names = checks.failedChecks.map((c) => c.name).join(', ');
    blockers.push(`CI failing: ${names || 'unknown checks'}`);
  }
  if (reviews.status === 'changes-requested') {
    const count = reviews.changesRequested;
    blockers.push(`Changes requested by ${count} reviewer${count !== 1 ? 's' : ''}`);
  }
  if (findings.openBySeverity.critical > 0) {
    const count = findings.openBySeverity.critical;
    blockers.push(`${count} open critical finding${count !== 1 ? 's' : ''}`);
  }

  if (checks.status === 'pending') {
    warnings.push('Checks still pending');
  } else if (checks.status === 'mixed') {
    warnings.push('Some checks failing');
  }

  const openMinorNitpick = findings.openBySeverity.minor + findings.openBySeverity.nitpick;
  if (openMinorNitpick > 0) {
    warnings.push(`${openMinorNitpick} open minor/nitpick finding${openMinorNitpick !== 1 ? 's' : ''}`);
  }
  if (findings.openBySeverity.major > 0) {
    const count = findings.openBySeverity.major;
    warnings.push(`${count} open major finding${count !== 1 ? 's' : ''}`);
  }

  let status: ReadinessAssessment['status'];
  if (blockers.length > 0) {
    status = 'blocked';
  } else if (warnings.length > 0) {
    status = 'needs-attention';
  } else {
    status = 'ready';
  }

  return { status, blockers, warnings };
}
