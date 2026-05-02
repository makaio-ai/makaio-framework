import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ReviewSubjects, VCSPRSubjects, VCSSubjects, type VCSPullRequestDetail } from '@makaio/contracts';
import { VCSPRAggregationService } from '../aggregation-service.js';

let bus: IMakaioBus | null = null;
let service: VCSPRAggregationService | null = null;
let cleanups: Array<() => void> = [];

afterEach(() => {
  service?.destroy();
  cleanups.forEach((cleanup) => cleanup());
  cleanups = [];
  service = null;
  bus = null;
});

/**
 * Build a PR detail fixture.
 * @param overrides - Fixture overrides
 * @returns Pull request detail fixture
 */
function makePullRequest(overrides: Partial<VCSPullRequestDetail> = {}): VCSPullRequestDetail {
  return {
    id: 'owner/repo#123',
    number: 123,
    title: 'Test PR',
    state: 'open',
    draft: false,
    author: 'alice',
    branch: 'feature',
    baseBranch: 'main',
    url: 'https://github.com/owner/repo/pull/123',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    mergedAt: null,
    head: null,
    body: null,
    reviews: [],
    labels: [],
    assignees: [],
    requestedReviewers: [],
    mergeable: true,
    ...overrides,
  };
}

describe('VCSPRAggregationService', () => {
  it('does not fetch checks or statuses when the PR has no head SHA', async () => {
    bus = createBusInstance();
    service = new VCSPRAggregationService(bus);
    await service.init();

    const checksGet = vi.fn();
    const statusesGet = vi.fn();
    const findingTargets: unknown[] = [];

    cleanups.push(
      bus.on(VCSSubjects.pr.get, (ctx) => {
        expect(ctx.payload).toEqual({ repoPath: '/repo', prNumber: 123 });
        ctx.setResult({ pullRequest: makePullRequest() });
      }),
    );
    cleanups.push(
      bus.on(VCSSubjects.checks.get, (ctx) => {
        checksGet(ctx.payload);
        ctx.setResult({ checks: [] });
      }),
    );
    cleanups.push(
      bus.on(VCSSubjects.statuses.get, (ctx) => {
        statusesGet(ctx.payload);
        ctx.setResult({ statuses: [] });
      }),
    );
    cleanups.push(
      bus.on(ReviewSubjects.findings.list, (ctx) => {
        findingTargets.push(ctx.payload.target);
        ctx.setResult({ findings: [] });
      }),
    );
    cleanups.push(
      bus.on(VCSSubjects.repository.get, (ctx) => {
        expect(ctx.payload.repoPath).toBe('/repo');
        ctx.setResult({
          repository: {
            provider: 'github',
            owner: 'owner',
            repo: 'repo',
            url: 'https://github.com/owner/repo',
          },
        });
      }),
    );

    const { pr } = await bus.request(VCSPRSubjects.get, { repoPath: '/repo', prNumber: 123 });

    expect(pr.headSha).toBe('');
    expect(pr.checks.total).toBe(0);
    expect(checksGet).not.toHaveBeenCalled();
    expect(statusesGet).not.toHaveBeenCalled();
    expect(findingTargets).toEqual([{ repository: '/repo', prNumber: 123, headSha: undefined }]);
  });
});
