import { describe, expect, it } from 'vitest';
import type { RawInboundHookPayload } from '@makaio/inbound-hooks';
import { normalizeGitHookEvent } from '../service/translate.js';

function raw(eventName: string, argv: string[] = [], stdinText = ''): RawInboundHookPayload {
  return {
    eventName,
    receivedAt: 1,
    argv,
    stdinText,
    payload: { repoPath: '/repo' },
  };
}

describe('normalizeGitHookEvent', () => {
  it('normalizes post-commit to a commit event', () => {
    expect(normalizeGitHookEvent(raw('post-commit'))).toEqual({
      kind: 'commit',
      repoPath: '/repo',
    });
  });

  it('normalizes a branch post-checkout', () => {
    expect(normalizeGitHookEvent(raw('post-checkout', ['old-sha', 'new-sha', '1']))).toEqual({
      kind: 'checkout',
      repoPath: '/repo',
      previousHead: 'old-sha',
      currentHead: 'new-sha',
    });
  });

  it('returns null for a file checkout (branchFlag === "0")', () => {
    expect(normalizeGitHookEvent(raw('post-checkout', ['old-sha', 'new-sha', '0']))).toBeNull();
  });

  it('normalizes post-merge with the squash flag', () => {
    expect(normalizeGitHookEvent(raw('post-merge', ['1']))).toEqual({
      kind: 'merge',
      repoPath: '/repo',
      squash: true,
    });
  });

  it('normalizes post-merge without a squash merge', () => {
    expect(normalizeGitHookEvent(raw('post-merge', ['0']))).toEqual({
      kind: 'merge',
      repoPath: '/repo',
      squash: false,
    });
  });

  it('normalizes post-rewrite rebase as a rewrite event', () => {
    expect(normalizeGitHookEvent(raw('post-rewrite', ['rebase'], 'abc123 def456\n'))).toEqual({
      kind: 'rewrite',
      repoPath: '/repo',
      command: 'rebase',
      rewritten: [{ oldHash: 'abc123', newHash: 'def456' }],
    });
  });

  it('normalizes post-rewrite amend as a rewrite event', () => {
    expect(normalizeGitHookEvent(raw('post-rewrite', ['amend'], 'abc123 def456\n'))).toEqual({
      kind: 'rewrite',
      repoPath: '/repo',
      command: 'amend',
      rewritten: [{ oldHash: 'abc123', newHash: 'def456' }],
    });
  });

  it('returns null when repoPath is missing', () => {
    const payload: RawInboundHookPayload = {
      eventName: 'post-commit',
      receivedAt: 1,
      argv: [],
      stdinText: '',
      payload: {},
    };
    expect(normalizeGitHookEvent(payload)).toBeNull();
  });

  it('returns null for an unrecognized event name', () => {
    expect(normalizeGitHookEvent(raw('pre-push'))).toBeNull();
  });

  it('parses multiple rewrite pairs', () => {
    const result = normalizeGitHookEvent(raw('post-rewrite', ['rebase'], 'aaa bbb\nccc ddd\n'));
    expect(result).toEqual({
      kind: 'rewrite',
      repoPath: '/repo',
      command: 'rebase',
      rewritten: [
        { oldHash: 'aaa', newHash: 'bbb' },
        { oldHash: 'ccc', newHash: 'ddd' },
      ],
    });
  });

  it('skips blank lines in rewrite pairs', () => {
    const result = normalizeGitHookEvent(raw('post-rewrite', ['rebase'], 'aaa bbb\n\nccc ddd\n'));
    expect(result).toEqual({
      kind: 'rewrite',
      repoPath: '/repo',
      command: 'rebase',
      rewritten: [
        { oldHash: 'aaa', newHash: 'bbb' },
        { oldHash: 'ccc', newHash: 'ddd' },
      ],
    });
  });
});
