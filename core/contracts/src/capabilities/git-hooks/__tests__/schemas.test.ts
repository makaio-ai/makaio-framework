import { describe, expect, it } from 'vitest';
import {
  GitHookCoverageRequestSchema,
  GitHookCoverageResponseSchema,
  GitHookNativeMergeEventSchema,
  GitHookRewriteEventSchema,
} from '../schemas.js';

describe('git hook capability schemas', () => {
  it('accepts a per-repo coverage request', () => {
    expect(
      GitHookCoverageRequestSchema.parse({
        repoPath: '/repo',
        operation: 'commit',
      }),
    ).toEqual({
      repoPath: '/repo',
      operation: 'commit',
    });
  });

  it('accepts a coverage request with optional worktree', () => {
    expect(
      GitHookCoverageRequestSchema.parse({
        repoPath: '/repo',
        operation: 'checkout',
        worktree: 'feature-branch',
      }),
    ).toEqual({
      repoPath: '/repo',
      operation: 'checkout',
      worktree: 'feature-branch',
    });
  });

  it('rejects a request with an empty repoPath', () => {
    expect(() =>
      GitHookCoverageRequestSchema.parse({
        repoPath: '',
        operation: 'commit',
      }),
    ).toThrow();
  });

  it('rejects a request with an unknown operation', () => {
    expect(() =>
      GitHookCoverageRequestSchema.parse({
        repoPath: '/repo',
        operation: 'push',
      }),
    ).toThrow();
  });

  it('accepts an uncovered response with a reason', () => {
    expect(
      GitHookCoverageResponseSchema.parse({
        covered: false,
        reason: 'not-installed',
        coveredOperations: [],
      }),
    ).toEqual({
      covered: false,
      reason: 'not-installed',
      coveredOperations: [],
    });
  });

  it('accepts a covered response with multiple operations', () => {
    expect(
      GitHookCoverageResponseSchema.parse({
        covered: true,
        reason: 'covered',
        coveredOperations: ['commit', 'checkout'],
      }),
    ).toEqual({
      covered: true,
      reason: 'covered',
      coveredOperations: ['commit', 'checkout'],
    });
  });

  it('rejects a response with an unknown reason code', () => {
    expect(() =>
      GitHookCoverageResponseSchema.parse({
        covered: false,
        reason: 'unknown-reason',
        coveredOperations: [],
      }),
    ).toThrow();
  });

  it('accepts native post-merge hook metadata without a source branch', () => {
    expect(
      GitHookNativeMergeEventSchema.parse({
        repoPath: '/repo',
        squash: true,
        targetBranch: 'main',
        currentHead: 'abc123',
        timestamp: '2026-05-24T12:00:00.000Z',
      }),
    ).toEqual({
      repoPath: '/repo',
      squash: true,
      targetBranch: 'main',
      currentHead: 'abc123',
      timestamp: '2026-05-24T12:00:00.000Z',
    });
  });

  it('accepts post-rewrite pairs with the rewrite command', () => {
    expect(
      GitHookRewriteEventSchema.parse({
        repoPath: '/repo',
        command: 'rebase',
        rewritten: [{ oldHash: 'old', newHash: 'new' }],
        branch: 'feature',
        timestamp: '2026-05-24T12:00:00.000Z',
      }),
    ).toEqual({
      repoPath: '/repo',
      command: 'rebase',
      rewritten: [{ oldHash: 'old', newHash: 'new' }],
      branch: 'feature',
      timestamp: '2026-05-24T12:00:00.000Z',
    });
  });
});
