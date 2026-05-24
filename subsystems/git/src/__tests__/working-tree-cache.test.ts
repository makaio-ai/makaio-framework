import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { GitSubjects } from '../namespace.js';
import { GitService } from '../git-service.js';
import * as gitQueries from '../queries/index.js';
import { configureTestGit } from './git-test-utils.js';

describe('GitService Working Tree Cache', { timeout: 20_000 }, () => {
  let bus: IMakaioBus;
  let service: GitService;
  let repoPath: string;
  let git: SimpleGit;
  let getWorkingTreeDetailsSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new GitService(bus);
    await service.init();

    repoPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-wt-cache-test-')));
    await bus.request(GitSubjects.initRepo, { path: repoPath });
    git = simpleGit(repoPath);
    await configureTestGit(repoPath);

    await fs.writeFile(path.join(repoPath, 'README.md'), '# Cache Test\n');
    await git.add('README.md');
    await git.commit('Initial commit');

    getWorkingTreeDetailsSpy = vi.spyOn(gitQueries, 'getWorkingTreeDetails') as ReturnType<typeof vi.spyOn>;
  });

  afterEach(async () => {
    getWorkingTreeDetailsSpy?.mockRestore();
    service.destroy();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('returns cached result on second identical request', async () => {
    const request = { repoPath };

    await bus.request(GitSubjects.getWorkingTreeDetails, request);
    await bus.request(GitSubjects.getWorkingTreeDetails, request);

    expect(getWorkingTreeDetailsSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * Parameterized invalidation tests. Each entry describes a git event
   * that should bust the working-tree cache.
   */
  const invalidationEvents = [
    {
      name: 'commit',
      subject: GitSubjects.commit,
      payload: () => ({
        repoPath,
        hash: 'abc123',
        message: 'test commit',
        author: 'test',
        email: 'test@test.com',
        branch: 'main',
        timestamp: new Date().toISOString(),
      }),
    },
    {
      name: 'staging',
      subject: GitSubjects.staging,
      payload: () => ({
        repoPath,
        staged: ['file.txt'],
        timestamp: new Date().toISOString(),
      }),
    },
    {
      name: 'checkout',
      subject: GitSubjects.checkout,
      payload: () => ({
        repoPath,
        currentBranch: 'feature',
        previousBranch: 'main',
        timestamp: new Date().toISOString(),
      }),
    },
    {
      name: 'merge',
      subject: GitSubjects.merge,
      payload: () => ({
        repoPath,
        sourceBranch: 'feature',
        targetBranch: 'main',
        mergeCommit: 'def456',
        timestamp: new Date().toISOString(),
      }),
    },
    {
      name: 'rebase',
      subject: GitSubjects.rebase,
      payload: () => ({
        repoPath,
        branch: 'feature',
        onto: 'main',
        status: 'completed' as const,
        timestamp: new Date().toISOString(),
      }),
    },
  ];

  for (const { name, subject, payload } of invalidationEvents) {
    it(`invalidates cached entries on ${name} event`, async () => {
      const request = { repoPath };

      await bus.request(GitSubjects.getWorkingTreeDetails, request);
      expect(getWorkingTreeDetailsSpy).toHaveBeenCalledTimes(1);

      await bus.emit(subject, payload());

      await bus.request(GitSubjects.getWorkingTreeDetails, request);
      expect(getWorkingTreeDetailsSpy).toHaveBeenCalledTimes(2);
    });
  }

  it('invalidates cache for subdirectory requests when root emits event', async () => {
    const subdir = path.join(repoPath, 'nested');
    await fs.mkdir(subdir, { recursive: true });
    const request = { repoPath: subdir };

    await bus.request(GitSubjects.getWorkingTreeDetails, request);
    expect(getWorkingTreeDetailsSpy).toHaveBeenCalledTimes(1);

    await bus.emit(GitSubjects.commit, {
      repoPath,
      hash: 'abc123',
      message: 'test commit',
      author: 'test',
      email: 'test@test.com',
      branch: 'main',
      timestamp: new Date().toISOString(),
    });

    await bus.request(GitSubjects.getWorkingTreeDetails, request);
    expect(getWorkingTreeDetailsSpy).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entry when cache exceeds 2x maxSize (20 entries)', async () => {
    const { GitWorkingTreeCache } = await import('../git-working-tree-cache.js');
    const cache = new GitWorkingTreeCache();

    const mockResponse = {
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      stats: {
        totalAdditions: 0,
        totalDeletions: 0,
        changedFiles: 0,
      },
    };

    // QuickLRU maintains between maxSize and 2×maxSize items (20-40 in this case)
    // Fill cache with 40 entries to reach the 2×maxSize threshold
    for (let i = 0; i < 40; i++) {
      const uniquePath = `${repoPath}-${i}`;
      const request = { repoPath: uniquePath };
      cache.set(request, uniquePath, uniquePath, mockResponse);
    }

    // Add 41st entry, which should trigger eviction of the oldest entry
    const newPath = `${repoPath}-999`;
    const newRequest = { repoPath: newPath };
    cache.set(newRequest, newPath, newPath, mockResponse);

    // Verify first entry was evicted
    const firstPath = `${repoPath}-0`;
    const firstRequest = { repoPath: firstPath };
    expect(cache.get(firstRequest, firstPath)).toBeUndefined();

    // Verify 41st entry is present
    expect(cache.get(newRequest, newPath)).toBeDefined();
  });

  it('returns correct working tree details after cache invalidation', async () => {
    const request = { repoPath };

    // First request - should be cached
    const result1 = await bus.request(GitSubjects.getWorkingTreeDetails, request);
    expect(result1.unstaged).toHaveLength(0);
    expect(result1.staged).toHaveLength(0);

    // Modify a file
    await fs.writeFile(path.join(repoPath, 'README.md'), '# Updated\n');

    // Emit staging event to invalidate cache
    await bus.emit(GitSubjects.staging, {
      repoPath,
      staged: [],
      timestamp: new Date().toISOString(),
    });

    // Second request - should reflect new changes
    const result2 = await bus.request(GitSubjects.getWorkingTreeDetails, request);
    expect(result2.unstaged).toHaveLength(1);
    expect(result2.unstaged[0].path).toBe('README.md');
  });
});
