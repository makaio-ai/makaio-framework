import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { GitSubjects } from '../namespace.js';
import { GitService } from '../git-service.js';
import { configureTestGit } from './git-test-utils.js';

let bus: IMakaioBus;
const GIT_WORKING_TREE_DETAILS_TIMEOUT_MS = 30_000;

describe('GitService Working Tree', { timeout: GIT_WORKING_TREE_DETAILS_TIMEOUT_MS }, () => {
  let gitService: GitService;

  beforeEach(async () => {
    bus = createBusInstance();
    gitService = new GitService(bus);
    await gitService.init();
  });

  afterEach(async () => {
    await gitService.destroy();
  });

  it('returns staged, unstaged, and untracked changes with stats', async () => {
    const { repoPath, git } = await createRepoWithInitialCommit();
    try {
      await fs.writeFile(path.join(repoPath, 'staged.txt'), 'staged\n');
      await git.add('staged.txt');

      await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\nunstaged\n');
      await fs.writeFile(path.join(repoPath, 'untracked.txt'), 'untracked\n');

      const details = await bus.request(GitSubjects.getWorkingTreeDetails, { repoPath });

      expect(details.staged.some((file) => file.path === 'staged.txt')).toBe(true);
      expect(details.unstaged.some((file) => file.path === 'base.txt')).toBe(true);
      expect(details.untracked.some((file) => file.path === 'untracked.txt')).toBe(true);
      expect(details.conflicted).toHaveLength(0);
      expect(details.stats.changedFiles).toBe(3);
      expect(details.stats.totalAdditions).toBe(2);
      expect(details.stats.totalDeletions).toBe(0);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('includes root commit changes in commit details', async () => {
    const { repoPath, git } = await createRepoWithInitialCommit();
    try {
      const log = await git.log({ maxCount: 1 });
      const hash = log.latest?.hash;

      expect(hash).toBeDefined();

      const details = await bus.request(GitSubjects.getCommitDetails, {
        repoPath,
        hash: hash ?? '',
      });

      expect(details.files.some((file) => file.path === 'base.txt')).toBe(true);
      expect(details.stats.changedFiles).toBe(1);
      expect(details.stats.totalAdditions).toBe(1);
      expect(details.stats.totalDeletions).toBe(0);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
  it('returns a unified diff', async () => {
    const { repoPath } = await createRepoWithInitialCommit();
    try {
      await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\nupdated\n');

      const response = await bus.request(GitSubjects.getDiff, {
        repoPath,
        staged: false,
        unified: 1,
      });

      expect(response.diff).toContain('base.txt');
      expect(response.diff).toContain('+updated');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('returns changed files for a merge commit', async () => {
    const { repoPath, git } = await createRepoWithInitialCommit();
    try {
      const originalBranch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

      // Create feature branch with one file change
      await git.raw(['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(repoPath, 'feature.txt'), 'feature content\n');
      await git.add('feature.txt');
      await git.commit('feature commit');

      // Return to main and add a diverging commit so merge creates a merge commit
      await git.checkout(originalBranch);
      await fs.writeFile(path.join(repoPath, 'main-extra.txt'), 'main extra\n');
      await git.add('main-extra.txt');
      await git.commit('main extra commit');

      // Merge feature branch — this produces a real merge commit with two parents
      await git.merge(['feature', '--no-ff', '--no-edit']);

      const log = await git.log({ maxCount: 1 });
      const mergeHash = log.latest?.hash;
      expect(mergeHash).toBeDefined();

      const details = await bus.request(GitSubjects.getCommitDetails, {
        repoPath,
        hash: mergeHash ?? '',
      });

      // A merge commit diffed against its first parent should show the files
      // brought in from the merged branch, not zero changed files
      expect(details.stats.changedFiles).toBeGreaterThan(0);
      expect(details.files.some((file) => file.path === 'feature.txt')).toBe(true);
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });

  it('returns diff for root commit', async () => {
    const { repoPath, git } = await createRepoWithInitialCommit();
    try {
      const log = await git.log({ maxCount: 1 });
      const hash = log.latest?.hash;

      expect(hash).toBeDefined();

      const response = await bus.request(GitSubjects.getDiff, {
        repoPath,
        ref: hash ?? '',
        unified: 1,
      });

      expect(response.diff).toContain('base.txt');
      expect(response.diff).toContain('+base');
    } finally {
      await fs.rm(repoPath, { recursive: true, force: true });
    }
  });
});

async function createRepoWithInitialCommit(): Promise<{ repoPath: string; git: SimpleGit }> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-git-test-'));
  await bus.request(GitSubjects.initRepo, { path: repoPath });
  const git = simpleGit(repoPath);
  await configureTestGit(repoPath);
  await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
  await git.add('base.txt');
  await git.commit('initial');
  return { repoPath, git };
}
