import { describe, expect, it } from 'vitest';
import type { VCSCheckRun, VCSCommitStatus, VCSReview, ReviewFinding } from '@makaio/contracts';
import {
  computeChecksSummary,
  computeReviewsSummary,
  computeFindingsSummary,
  classifyLabel,
  classifyLabels,
  computeReadiness,
} from '../aggregators.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCheckRun(overrides: Partial<VCSCheckRun> = {}): VCSCheckRun {
  return {
    id: 1,
    name: 'lint',
    status: 'completed',
    conclusion: 'success',
    startedAt: null,
    completedAt: '2024-01-01T00:00:00Z',
    url: 'https://example.com/runs/1',
    ...overrides,
  };
}

function makeCommitStatus(overrides: Partial<VCSCommitStatus> = {}): VCSCommitStatus {
  return {
    id: 1,
    state: 'success',
    description: 'OK',
    targetUrl: 'https://example.com',
    context: 'ci/default',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    creator: null,
    ...overrides,
  };
}

function makeReview(overrides: Partial<VCSReview> = {}): VCSReview {
  return {
    id: 1,
    author: 'alice',
    state: 'APPROVED',
    body: null,
    submittedAt: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'finding-1',
    target: { repository: 'owner/repo', prNumber: 1 },
    sourceId: 'source-1',
    reviewer: 'coderabbit',
    origin: 'inline',
    threadId: null,
    severity: 'minor',
    file: 'src/foo.ts',
    startLine: 10,
    endLine: 10,
    message: 'Unused variable',
    agentPrompt: null,
    suggestedChanges: [],
    status: 'open',
    addressedBy: null,
    addressedAt: null,
    verifiedAt: null,
    dismissedReason: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rawCommentId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeChecksSummary
// ---------------------------------------------------------------------------

describe('computeChecksSummary', () => {
  it('returns passing when all checks succeed', () => {
    const runs = [
      makeCheckRun({ id: 1, name: 'lint', conclusion: 'success' }),
      makeCheckRun({ id: 2, name: 'test', conclusion: 'success' }),
    ];
    const result = computeChecksSummary(runs, []);

    expect(result.status).toBe('passing');
    expect(result.total).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.failedChecks).toHaveLength(0);
  });

  it('returns failing when a check fails and none are pending', () => {
    const runs = [
      makeCheckRun({ id: 1, name: 'lint', conclusion: 'failure' }),
      makeCheckRun({ id: 2, name: 'test', conclusion: 'success' }),
    ];
    const result = computeChecksSummary(runs, []);

    expect(result.status).toBe('failing');
    expect(result.failed).toBe(1);
    expect(result.failedChecks).toHaveLength(1);
    expect(result.failedChecks[0]?.name).toBe('lint');
    expect(result.failedChecks[0]?.source).toBe('check-run');
  });

  it('returns mixed when there are both failures and pending checks', () => {
    const runs = [
      makeCheckRun({ id: 1, name: 'lint', conclusion: 'failure' }),
      makeCheckRun({ id: 2, name: 'build', status: 'in_progress', conclusion: null }),
    ];
    const result = computeChecksSummary(runs, []);

    expect(result.status).toBe('mixed');
    expect(result.pending).toBe(1);
  });

  it('returns pending when some checks are not yet complete', () => {
    const runs = [
      makeCheckRun({ id: 1, conclusion: 'success' }),
      makeCheckRun({ id: 2, status: 'queued', conclusion: null }),
    ];
    const result = computeChecksSummary(runs, []);

    expect(result.status).toBe('pending');
    expect(result.pending).toBe(1);
  });

  it('counts skipped check runs correctly', () => {
    const runs = [makeCheckRun({ conclusion: 'skipped' }), makeCheckRun({ id: 2, conclusion: 'cancelled' })];
    const result = computeChecksSummary(runs, []);

    expect(result.skipped).toBe(2);
    expect(result.failedChecks).toHaveLength(0);
  });

  it('merges commit statuses into the summary', () => {
    const statuses = [
      makeCommitStatus({ id: 10, state: 'failure', context: 'security/scan' }),
      makeCommitStatus({ id: 11, state: 'success', context: 'ci/build' }),
    ];
    const result = computeChecksSummary([], statuses);

    expect(result.failed).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.failedChecks[0]?.source).toBe('commit-status');
    expect(result.failedChecks[0]?.name).toBe('security/scan');
  });

  it('returns No checks summary for empty inputs', () => {
    const result = computeChecksSummary([], []);
    expect(result.total).toBe(0);
    expect(result.summary).toBe('No checks');
  });
});

// ---------------------------------------------------------------------------
// computeReviewsSummary
// ---------------------------------------------------------------------------

describe('computeReviewsSummary', () => {
  it('returns approved when all reviewers approved', () => {
    const reviews = [makeReview({ author: 'alice' }), makeReview({ id: 2, author: 'bob' })];
    const result = computeReviewsSummary(reviews);

    expect(result.status).toBe('approved');
    expect(result.approvals).toBe(2);
    expect(result.changesRequested).toBe(0);
  });

  it('returns changes-requested even when some approved', () => {
    const reviews = [
      makeReview({ author: 'alice', state: 'APPROVED' }),
      makeReview({ id: 2, author: 'bob', state: 'CHANGES_REQUESTED' }),
    ];
    const result = computeReviewsSummary(reviews);

    expect(result.status).toBe('changes-requested');
    expect(result.changesRequested).toBe(1);
  });

  it('takes the latest state per reviewer', () => {
    const reviews = [
      makeReview({ id: 1, author: 'alice', state: 'CHANGES_REQUESTED', submittedAt: '2024-01-01T00:00:00Z' }),
      // Later review by alice overrides earlier
      makeReview({ id: 2, author: 'alice', state: 'APPROVED', submittedAt: '2024-01-02T00:00:00Z' }),
    ];
    const result = computeReviewsSummary(reviews);

    expect(result.approvals).toBe(1);
    expect(result.changesRequested).toBe(0);
    expect(result.status).toBe('approved');
  });

  it('returns pending when there are no reviews', () => {
    const result = computeReviewsSummary([]);
    expect(result.status).toBe('pending');
    expect(result.summary).toBe('No reviews');
  });

  it('counts comment-only reviews separately', () => {
    const reviews = [makeReview({ state: 'COMMENTED' })];
    const result = computeReviewsSummary(reviews);

    expect(result.commented).toBe(1);
    expect(result.approvals).toBe(0);
    expect(result.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// computeFindingsSummary
// ---------------------------------------------------------------------------

describe('computeFindingsSummary', () => {
  it('returns No findings summary for empty list', () => {
    const result = computeFindingsSummary([]);
    expect(result.total).toBe(0);
    expect(result.summary).toBe('No findings');
  });

  it('counts open findings by severity', () => {
    const findings = [
      makeFinding({ severity: 'critical', status: 'open' }),
      makeFinding({ id: 'f2', severity: 'major', status: 'open' }),
      makeFinding({ id: 'f3', severity: 'minor', status: 'open' }),
      makeFinding({ id: 'f4', severity: 'nitpick', status: 'addressed' }),
    ];
    const result = computeFindingsSummary(findings);

    expect(result.total).toBe(4);
    expect(result.open).toBe(3);
    expect(result.addressed).toBe(1);
    expect(result.openBySeverity.critical).toBe(1);
    expect(result.openBySeverity.major).toBe(1);
    expect(result.openBySeverity.minor).toBe(1);
    expect(result.openBySeverity.nitpick).toBe(0);
  });

  it('treats deferred as dismissed for summary count', () => {
    const findings = [makeFinding({ status: 'dismissed' }), makeFinding({ id: 'f2', status: 'deferred' })];
    const result = computeFindingsSummary(findings);
    expect(result.dismissed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// classifyLabel / classifyLabels
// ---------------------------------------------------------------------------

describe('classifyLabel', () => {
  it.each<[string, string]>([
    ['priority: high', 'priority'],
    ['P0 - critical', 'priority'],
    ['urgent fix', 'priority'],
    ['WIP', 'status'],
    ['ready for review', 'status'],
    ['blocked', 'status'],
    ['bug', 'type'],
    ['feature request', 'type'],
    ['enhancement', 'type'],
    ['size/xl', 'size'],
    ['xs', 'size'],
    ['xl', 'size'],
    ['needs review', 'review'],
    ['approved', 'review'],
    ['automerge', 'automation'],
    ['bot', 'automation'],
    ['ci', 'automation'],
  ])('classifies "%s" as %s', (label, expected) => {
    expect(classifyLabel(label)).toBe(expected);
  });

  it('returns null for unrecognised labels', () => {
    expect(classifyLabel('random-label')).toBeNull();
    expect(classifyLabel('unknown')).toBeNull();
  });
});

describe('classifyLabels', () => {
  it('classifies an array of labels and preserves all names', () => {
    const result = classifyLabels(['bug', 'WIP', 'unknown']);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: 'bug', semantic: 'type' });
    expect(result[1]).toEqual({ name: 'WIP', semantic: 'status' });
    expect(result[2]).toEqual({ name: 'unknown', semantic: null });
  });
});

// ---------------------------------------------------------------------------
// computeReadiness
// ---------------------------------------------------------------------------

describe('computeReadiness', () => {
  const passingChecks = computeChecksSummary([makeCheckRun()], []);
  const approvedReviews = computeReviewsSummary([makeReview()]);
  const noFindings = computeFindingsSummary([]);
  const cleanPR = { state: 'open' as const, draft: false, mergeable: true };

  it('returns ready when everything is clean', () => {
    const result = computeReadiness(cleanPR, passingChecks, approvedReviews, noFindings);
    expect(result.status).toBe('ready');
    expect(result.blockers).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('blocks on draft PRs', () => {
    const result = computeReadiness({ ...cleanPR, draft: true }, passingChecks, approvedReviews, noFindings);
    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('PR is a draft');
  });

  it('blocks on non-open PRs', () => {
    const closed = computeReadiness({ ...cleanPR, state: 'closed' }, passingChecks, approvedReviews, noFindings);
    const merged = computeReadiness({ ...cleanPR, state: 'merged' }, passingChecks, approvedReviews, noFindings);

    expect(closed.status).toBe('blocked');
    expect(closed.blockers).toContain('PR is closed');
    expect(merged.status).toBe('blocked');
    expect(merged.blockers).toContain('PR is merged');
  });

  it('blocks on merge conflicts', () => {
    const result = computeReadiness({ ...cleanPR, mergeable: false }, passingChecks, approvedReviews, noFindings);
    expect(result.status).toBe('blocked');
    expect(result.blockers).toContain('Merge conflicts detected');
  });

  it('blocks on failing CI', () => {
    const failingChecks = computeChecksSummary([makeCheckRun({ name: 'lint', conclusion: 'failure' })], []);
    const result = computeReadiness(cleanPR, failingChecks, approvedReviews, noFindings);
    expect(result.status).toBe('blocked');
    expect(result.blockers.some((b) => b.includes('CI failing'))).toBe(true);
  });

  it('blocks on changes requested', () => {
    const changesReviews = computeReviewsSummary([makeReview({ state: 'CHANGES_REQUESTED' })]);
    const result = computeReadiness(cleanPR, passingChecks, changesReviews, noFindings);
    expect(result.status).toBe('blocked');
    expect(result.blockers.some((b) => b.includes('Changes requested'))).toBe(true);
  });

  it('blocks on open critical findings', () => {
    const findings = computeFindingsSummary([makeFinding({ severity: 'critical' })]);
    const result = computeReadiness(cleanPR, passingChecks, approvedReviews, findings);
    expect(result.status).toBe('blocked');
    expect(result.blockers.some((b) => b.includes('critical'))).toBe(true);
  });

  it('warns on pending checks', () => {
    const pendingChecks = computeChecksSummary([makeCheckRun({ status: 'queued', conclusion: null })], []);
    const result = computeReadiness(cleanPR, pendingChecks, approvedReviews, noFindings);
    expect(result.status).toBe('needs-attention');
    expect(result.warnings).toContain('Checks still pending');
  });

  it('warns on open minor findings', () => {
    const findings = computeFindingsSummary([makeFinding({ severity: 'minor' })]);
    const result = computeReadiness(cleanPR, passingChecks, approvedReviews, findings);
    expect(result.status).toBe('needs-attention');
    expect(result.warnings.some((w) => w.includes('minor/nitpick'))).toBe(true);
  });
});
