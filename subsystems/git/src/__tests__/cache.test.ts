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

describe('GitService Log Cache', { timeout: 30_000 }, () => {
  let bus: IMakaioBus;
  let service: GitService;
  let repoPath: string;
  let git: SimpleGit;
  let getLogSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new GitService(bus);
    await service.init();

    repoPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-cache-test-')));
    await bus.request(GitSubjects.initRepo, { path: repoPath });
    git = simpleGit(repoPath);
    await configureTestGit(repoPath);

    await fs.writeFile(path.join(repoPath, 'README.md'), '# Cache Test\n');
    await git.add('README.md');
    await git.commit('Initial commit');

    getLogSpy = vi.spyOn(gitQueries, 'getLog') as ReturnType<typeof vi.spyOn>;
  });

  afterEach(async () => {
    getLogSpy?.mockRestore();
    service.destroy();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('returns cached result on second identical request', async () => {
    const request = { repoPath, limit: 50 };

    await bus.request(GitSubjects.getLog, request);
    await bus.request(GitSubjects.getLog, request);

    expect(getLogSpy).toHaveBeenCalledTimes(1);
  });

  it('normalizes filter path order for cache keys', async () => {
    await fs.writeFile(path.join(repoPath, 'src-a.txt'), 'a');
    await fs.writeFile(path.join(repoPath, 'src-b.txt'), 'b');
    await git.add(['src-a.txt', 'src-b.txt']);
    await git.commit('Add files');

    const request1 = { repoPath, filters: { paths: ['src-b.txt', 'src-a.txt'] } };
    const request2 = { repoPath, filters: { paths: ['src-a.txt', 'src-b.txt'] } };

    await bus.request(GitSubjects.getLog, request1);
    await bus.request(GitSubjects.getLog, request2);

    expect(getLogSpy).toHaveBeenCalledTimes(1);
  });

  it('normalizes selectedWorktree spelling for cache keys', async () => {
    const alternateWorktreePath = path.join(repoPath, '..', path.basename(repoPath));

    const request1 = { repoPath, filters: { selectedWorktree: repoPath } };
    const request2 = { repoPath, filters: { selectedWorktree: alternateWorktreePath } };

    await bus.request(GitSubjects.getLog, request1);
    await bus.request(GitSubjects.getLog, request2);

    expect(getLogSpy).toHaveBeenCalledTimes(1);
  });

  /** Emits a test commit event on the root repo path. */
  async function emitTestCommit(): Promise<void> {
    await bus.emit(GitSubjects.commit, {
      repoPath,
      hash: 'abc123',
      message: 'test commit',
      author: 'test',
      email: 'test@test.com',
      branch: 'main',
      timestamp: new Date().toISOString(),
    });
  }

  it('invalidates cached entries on commit event', async () => {
    const request = { repoPath, limit: 10 };

    await bus.request(GitSubjects.getLog, request);
    expect(getLogSpy).toHaveBeenCalledTimes(1);

    await emitTestCommit();

    await bus.request(GitSubjects.getLog, request);
    expect(getLogSpy).toHaveBeenCalledTimes(2);
  });

  it('invalidates cache for subdirectory requests when root emits event', async () => {
    const subdir = path.join(repoPath, 'nested');
    await fs.mkdir(subdir, { recursive: true });
    const request = { repoPath: subdir, limit: 10 };

    await bus.request(GitSubjects.getLog, request);
    expect(getLogSpy).toHaveBeenCalledTimes(1);

    await emitTestCommit();

    await bus.request(GitSubjects.getLog, request);
    expect(getLogSpy).toHaveBeenCalledTimes(2);
  });

  it('evicts oldest entry when cache exceeds 2x maxSize (20 entries)', async () => {
    const { GitLogCache } = await import('../git-log-cache.js');
    const cache = new GitLogCache();

    const mockResponse = {
      commits: [],
      refs: {
        branches: {},
        remoteBranches: {},
        tags: {},
        HEAD: 'abc123',
      },
      truncated: false,
    };

    // QuickLRU maintains between maxSize and 2×maxSize items (20-40 in this case)
    // Fill cache with 40 entries to reach the 2×maxSize threshold
    for (let i = 0; i < 40; i++) {
      const request = { repoPath, limit: i + 1 };
      cache.set(request, repoPath, repoPath, mockResponse);
    }

    // Add 41st entry, which should trigger eviction of the oldest entry
    const newRequest = { repoPath, limit: 999 };
    cache.set(newRequest, repoPath, repoPath, mockResponse);

    // Verify first entry was evicted
    const firstRequest = { repoPath, limit: 1 };
    expect(cache.get(firstRequest, repoPath)).toBeUndefined();

    // Verify 41st entry is present
    expect(cache.get(newRequest, repoPath)).toBeDefined();
  });
});
