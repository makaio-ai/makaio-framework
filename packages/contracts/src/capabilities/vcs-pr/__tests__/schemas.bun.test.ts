import { describe, expect, it } from 'bun:test';
import { CheckRunDetailSchema, ReviewerStateSchema, VCSPRSchemas } from '../schemas.js';

describe('VCSPRSchemas', () => {
  it('requires prNumber on pull request event targets', () => {
    const result = VCSPRSchemas.conflicted.safeParse({
      target: {
        repository: 'owner/repo',
      },
    });

    expect(result.success).toBe(false);
  });

  it('validates ISO datetime fields in check and reviewer summaries', () => {
    expect(
      CheckRunDetailSchema.safeParse({
        id: 1,
        name: 'lint',
        workflowName: 'ci',
        conclusion: 'failure',
        failedStep: null,
        detailsUrl: 'https://example.com/check',
        completedAt: '2024-01-01T00:00:00Z',
        source: 'check-run',
      }).success,
    ).toBe(true);
    expect(
      ReviewerStateSchema.safeParse({
        reviewer: 'alice',
        state: 'APPROVED',
        submittedAt: '2024-01-01T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      CheckRunDetailSchema.safeParse({
        id: 1,
        name: 'lint',
        workflowName: 'ci',
        conclusion: 'failure',
        failedStep: null,
        detailsUrl: 'https://example.com/check',
        completedAt: 'soon',
        source: 'check-run',
      }).success,
    ).toBe(false);
    expect(ReviewerStateSchema.safeParse({ reviewer: 'alice', state: 'APPROVED', submittedAt: 'later' }).success).toBe(
      false,
    );
  });

  it('rejects malformed URL and numeric fields in PR summaries', () => {
    expect(
      CheckRunDetailSchema.safeParse({
        id: -1,
        name: 'lint',
        workflowName: 'ci',
        conclusion: 'failure',
        failedStep: null,
        detailsUrl: 'not a url',
        completedAt: '2024-01-01T00:00:00Z',
        source: 'check-run',
      }).success,
    ).toBe(false);
  });
});
