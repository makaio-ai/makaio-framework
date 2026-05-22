import { describe, expect, it } from 'vitest';
import { createEvent } from './shared.js';

describe('createEvent', () => {
  it('applies git payload overrides for fixture callers', () => {
    const gitCommit = createEvent({
      sessionId: 'session-1',
      type: 'git.commit',
      payload: {
        hash: 'sha-fixed',
        message: 'Fixed commit',
        branch: 'feature/refactor',
        repoPath: '/repo/custom',
        author: 'Ada',
        email: 'ada@example.com',
        commitTimestamp: '2026-04-10T10:00:00.000Z',
        worktree: '/repo/worktrees/refactor',
      },
    });

    expect(gitCommit.payload).toMatchObject({
      hash: 'sha-fixed',
      message: 'Fixed commit',
      branch: 'feature/refactor',
      repoPath: '/repo/custom',
      author: 'Ada',
      email: 'ada@example.com',
      commitTimestamp: '2026-04-10T10:00:00.000Z',
      worktree: '/repo/worktrees/refactor',
    });

    const gitCheckout = createEvent({
      sessionId: 'session-1',
      type: 'git.checkout',
      payload: {
        previousBranch: 'main',
        currentBranch: 'feature/refactor',
        repoPath: '/repo/custom',
        worktree: '/repo/worktrees/refactor',
      },
    });

    expect(gitCheckout.payload).toMatchObject({
      previousBranch: 'main',
      currentBranch: 'feature/refactor',
      repoPath: '/repo/custom',
      worktree: '/repo/worktrees/refactor',
    });
  });
});
