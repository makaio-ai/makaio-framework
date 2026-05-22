import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { VCSSubjects, type VCSReviewComment } from '@makaio/contracts';
import { CodeRabbitSource } from '../source.js';

const target = { repository: 'makaio-ai/makaio', prNumber: 42 };

function makeComment(id: number, author: string): VCSReviewComment {
  return {
    id,
    author,
    body: `Comment ${id}`,
    path: 'src/example.ts',
    line: id,
    createdAt: '2026-05-20T12:00:00.000Z',
    updatedAt: '2026-05-20T12:00:00.000Z',
    inReplyToId: null,
    threadId: null,
    isResolved: false,
  };
}

function makePullRequest(reviews: Array<{ id: number; author: string }>) {
  return {
    id: 'makaio-ai/makaio#42',
    number: 42,
    title: 'Test PR',
    state: 'open' as const,
    draft: false,
    author: 'chris',
    branch: 'feature',
    baseBranch: 'develop',
    url: 'https://github.com/makaio-ai/makaio/pull/42',
    createdAt: '2026-05-20T12:00:00.000Z',
    updatedAt: '2026-05-20T12:00:00.000Z',
    mergedAt: null,
    head: null,
    body: null,
    reviews: reviews.map((review) => ({
      ...review,
      state: 'COMMENTED' as const,
      body: `Review ${review.id}`,
      submittedAt: '2026-05-20T12:00:00.000Z',
    })),
    labels: [],
    assignees: [],
    requestedReviewers: [],
    mergeable: null,
  };
}

describe('CodeRabbitSource', () => {
  it('fetches VCS comments and reviews filtered to CodeRabbit bot authors', async () => {
    const bus = createBusInstance();
    const seenRequests: unknown[] = [];
    bus.on(VCSSubjects.comments.list, (ctx) => {
      seenRequests.push(ctx.payload);
      ctx.setResult({
        comments: [makeComment(1, 'coderabbitai[bot]'), makeComment(2, 'human')],
      });
    });
    bus.on(VCSSubjects.pr.get, (ctx) => {
      seenRequests.push(ctx.payload);
      ctx.setResult({
        pullRequest: makePullRequest([
          { id: 10, author: 'coderabbitai[bot]' },
          { id: 11, author: 'human' },
        ]),
      });
    });

    const snapshot = await new CodeRabbitSource(bus).fetchSnapshot({ repoPath: '/repo', target });

    expect(seenRequests).toEqual([
      { repoPath: '/repo', prNumber: 42 },
      { repoPath: '/repo', prNumber: 42 },
    ]);
    expect(snapshot.sourceId).toBe('coderabbit');
    expect(snapshot.reviewer).toBe('coderabbit');
    expect(snapshot.target).toBe(target);
    expect(snapshot.comments.map((comment) => comment.id)).toEqual([1]);
    expect(snapshot.reviews.map((review) => review.id)).toEqual([10]);
  });

  it('requires a PR number', async () => {
    const source = new CodeRabbitSource(createBusInstance());

    await expect(
      source.fetchSnapshot({
        repoPath: '/repo',
        target: { repository: 'makaio-ai/makaio' },
      }),
    ).rejects.toThrow('CodeRabbit source requires a PR number');
  });

  it('returns no reviews when the VCS provider cannot find the pull request', async () => {
    const bus = createBusInstance();
    bus.on(VCSSubjects.comments.list, (ctx) => {
      ctx.setResult({ comments: [makeComment(1, 'coderabbitai[bot]')] });
    });
    bus.on(VCSSubjects.pr.get, (ctx) => {
      ctx.setResult({ pullRequest: null });
    });

    const snapshot = await new CodeRabbitSource(bus).fetchSnapshot({ repoPath: '/repo', target });

    expect(snapshot.comments.map((comment) => comment.id)).toEqual([1]);
    expect(snapshot.reviews).toEqual([]);
  });
});
