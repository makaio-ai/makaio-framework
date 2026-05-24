import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { GitHookNamespace, GitHookSubjects } from '@makaio/contracts';
import type { RawInboundHookPayload } from '@makaio/inbound-hooks';
import { createInboundHookNamespace, createInboundHookReceivedSubject } from '@makaio/inbound-hooks';
import { GitNamespace, GitSubjects } from '@makaio/services-core/git/namespace';
import { gitOutput } from '../install/git-command.js';
import { readGitHookStatus } from '../install/status.js';
import { GitHookTranslatorService } from '../service/git-hook-translator-service.js';

vi.mock('../install/git-command.js', () => ({
  gitOutput: vi.fn(),
}));

vi.mock('../install/status.js', () => ({
  readGitHookStatus: vi.fn(),
}));

const gitOutputMock = vi.mocked(gitOutput);
const readGitHookStatusMock = vi.mocked(readGitHookStatus);

function raw(eventName: string, argv: string[] = [], stdinText = ''): RawInboundHookPayload {
  return {
    eventName,
    receivedAt: 1,
    argv,
    stdinText,
    payload: { repoPath: '/repo' },
  };
}

async function createHarness(): Promise<{ bus: IMakaioBus; service: GitHookTranslatorService }> {
  const bus = createBusInstance();
  bus.registerNamespace(createInboundHookNamespace('git'));
  bus.registerNamespace(GitHookNamespace);
  bus.registerNamespace(GitNamespace);

  const service = new GitHookTranslatorService(bus);
  await service.init();
  return { bus, service };
}

beforeEach(() => {
  gitOutputMock.mockReset();
  readGitHookStatusMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitHookTranslatorService', () => {
  it('emits commit events from post-commit hooks', async () => {
    gitOutputMock
      .mockResolvedValueOnce('abc123\x00feat: test\x00Dev\x00dev@example.com\x002026-05-24T10:00:00.000Z')
      .mockResolvedValueOnce('main');
    const { bus, service } = await createHarness();
    const commits: unknown[] = [];
    const cleanup = bus.on(GitSubjects.commit, ({ payload }) => {
      commits.push(payload);
    });

    await bus.emit(createInboundHookReceivedSubject('git'), raw('post-commit'));
    cleanup();
    await service.destroy();

    expect(commits).toEqual([
      {
        repoPath: '/repo',
        hash: 'abc123',
        message: 'feat: test',
        author: 'Dev',
        email: 'dev@example.com',
        branch: 'main',
        timestamp: '2026-05-24T10:00:00.000Z',
      },
    ]);
  });

  it('emits checkout without treating the previous HEAD hash as a previous branch', async () => {
    gitOutputMock.mockResolvedValueOnce('main');
    const { bus, service } = await createHarness();
    const checkouts: unknown[] = [];
    const cleanup = bus.on(GitSubjects.checkout, ({ payload }) => {
      checkouts.push(payload);
    });

    await bus.emit(createInboundHookReceivedSubject('git'), raw('post-checkout', ['old-sha', 'new-sha', '1']));
    cleanup();
    await service.destroy();

    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toMatchObject({
      repoPath: '/repo',
      currentBranch: 'main',
    });
    expect(checkouts[0]).not.toHaveProperty('previousBranch');
  });

  it('emits native merge hook metadata instead of inventing a canonical source branch', async () => {
    gitOutputMock.mockResolvedValueOnce('main').mockResolvedValueOnce('merge-sha');
    const { bus, service } = await createHarness();
    const nativeMerges: unknown[] = [];
    const canonicalMerges: unknown[] = [];
    const cleanupNative = bus.on(GitHookSubjects.merge, ({ payload }) => {
      nativeMerges.push(payload);
    });
    const cleanupCanonical = bus.on(GitSubjects.merge, ({ payload }) => {
      canonicalMerges.push(payload);
    });

    await bus.emit(createInboundHookReceivedSubject('git'), raw('post-merge', ['1']));
    cleanupNative();
    cleanupCanonical();
    await service.destroy();

    expect(nativeMerges).toHaveLength(1);
    expect(nativeMerges[0]).toMatchObject({
      repoPath: '/repo',
      squash: true,
      targetBranch: 'main',
      currentHead: 'merge-sha',
    });
    expect(canonicalMerges).toEqual([]);
  });

  it('emits post-rewrite pairs as typed hook metadata', async () => {
    gitOutputMock.mockResolvedValueOnce('feature');
    const { bus, service } = await createHarness();
    const rewrites: unknown[] = [];
    const rebases: unknown[] = [];
    const cleanupRewrite = bus.on(GitHookSubjects.rewrite, ({ payload }) => {
      rewrites.push(payload);
    });
    const cleanupRebase = bus.on(GitSubjects.rebase, ({ payload }) => {
      rebases.push(payload);
    });

    await bus.emit(
      createInboundHookReceivedSubject('git'),
      raw('post-rewrite', ['rebase'], 'old-a new-a\nold-b new-b\n'),
    );
    cleanupRewrite();
    cleanupRebase();
    await service.destroy();

    expect(rewrites).toHaveLength(1);
    expect(rewrites[0]).toMatchObject({
      repoPath: '/repo',
      command: 'rebase',
      branch: 'feature',
      rewritten: [
        { oldHash: 'old-a', newHash: 'new-a' },
        { oldHash: 'old-b', newHash: 'new-b' },
      ],
    });
    expect(rebases).toEqual([]);
  });

  it('ignores hook events that do not normalize to git operations', async () => {
    const { bus, service } = await createHarness();
    const commits: unknown[] = [];
    const checkouts: unknown[] = [];
    const cleanupCommit = bus.on(GitSubjects.commit, ({ payload }) => {
      commits.push(payload);
    });
    const cleanupCheckout = bus.on(GitSubjects.checkout, ({ payload }) => {
      checkouts.push(payload);
    });

    await bus.emit(createInboundHookReceivedSubject('git'), raw('pre-push'));
    await bus.emit(createInboundHookReceivedSubject('git'), raw('post-checkout', ['old-sha', 'new-sha', '0']));
    cleanupCommit();
    cleanupCheckout();
    await service.destroy();

    expect(commits).toEqual([]);
    expect(checkouts).toEqual([]);
    expect(gitOutputMock).not.toHaveBeenCalled();
  });

  it('answers coverage requests through the provider', async () => {
    readGitHookStatusMock.mockResolvedValueOnce({
      covered: true,
      reason: 'covered',
      coveredOperations: ['commit', 'checkout'],
    });
    const { bus, service } = await createHarness();

    const result = await bus.request(GitHookSubjects.coverage, {
      repoPath: '/repo',
      operation: 'commit',
    });
    await service.destroy();

    expect(result).toEqual({
      covered: true,
      reason: 'covered',
      coveredOperations: ['commit', 'checkout'],
    });
  });

  it('cleans up inbound hook and coverage handlers on destroy', async () => {
    gitOutputMock
      .mockResolvedValueOnce('abc123\x00feat: test\x00Dev\x00dev@example.com\x002026-05-24T10:00:00.000Z')
      .mockResolvedValueOnce('main');
    const { bus, service } = await createHarness();
    const commits: unknown[] = [];
    const cleanup = bus.on(GitSubjects.commit, ({ payload }) => {
      commits.push(payload);
    });

    await service.destroy();
    await bus.emit(createInboundHookReceivedSubject('git'), raw('post-commit'));
    const coverageResult = await bus.requestOptional(GitHookSubjects.coverage, {
      repoPath: '/repo',
      operation: 'commit',
    });
    cleanup();

    expect(commits).toEqual([]);
    expect(gitOutputMock).not.toHaveBeenCalled();
    expect(coverageResult.handled).toBe(false);
  });
});
