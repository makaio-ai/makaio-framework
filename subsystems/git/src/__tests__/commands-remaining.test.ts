/**
 * Integration tests for git write commands: rename, discard, push, pull, fetch.
 *
 * Tests use real temporary git repositories to verify actual git behavior.
 * No mocks - tests exercise real git operations.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { createTestRepoWithCommit, type TestRepo } from './git-test-utils.js';
import { renameBranch, createBranch } from '../commands/branch.js';
import { discardChanges } from '../commands/discard.js';
import { push, pull, fetch } from '../commands/remote-ops.js';
import { stashApply } from '../commands/stash.js';

describe('Git Write Commands - Remaining', { timeout: 20_000 }, () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithCommit('git-cmd-rem-');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe('renameBranch', () => {
    it('should rename a branch', async () => {
      await createBranch(repo.git, 'old-name');

      const result = await renameBranch(repo.git, 'old-name', 'new-name');

      expect(result.success).toBe(true);

      const branches = await repo.git.branchLocal();
      expect(branches.all).toContain('new-name');
      expect(branches.all).not.toContain('old-name');
    });

    it('should fail to rename a non-existent branch', async () => {
      const result = await renameBranch(repo.git, 'nonexistent', 'something');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should fail when target name already exists', async () => {
      await createBranch(repo.git, 'branch-a');
      await createBranch(repo.git, 'branch-b');

      const result = await renameBranch(repo.git, 'branch-a', 'branch-b');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('discardChanges', () => {
    it('should restore a modified file to HEAD state', async () => {
      const filePath = path.join(repo.repoPath, 'base.txt');
      await fs.writeFile(filePath, 'modified content');

      const result = await discardChanges(repo.git, ['base.txt']);

      expect(result.success).toBe(true);

      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('base\n');
    });

    it('should discard changes to multiple files', async () => {
      const file1 = path.join(repo.repoPath, 'base.txt');
      const file2 = path.join(repo.repoPath, 'second.txt');

      // Create and commit second file
      await fs.writeFile(file2, 'original\n');
      await repo.git.add('second.txt');
      await repo.git.commit('add second');

      // Modify both
      await fs.writeFile(file1, 'changed');
      await fs.writeFile(file2, 'changed');

      const result = await discardChanges(repo.git, ['base.txt', 'second.txt']);

      expect(result.success).toBe(true);

      const content1 = await fs.readFile(file1, 'utf-8');
      const content2 = await fs.readFile(file2, 'utf-8');
      expect(content1).toBe('base\n');
      expect(content2).toBe('original\n');
    });

    it('should return error for empty paths', async () => {
      const result = await discardChanges(repo.git, []);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No paths provided');
    });

    it('should fail for paths that do not exist in the repo', async () => {
      const result = await discardChanges(repo.git, ['nonexistent.txt']);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('stashApply', () => {
    it('should apply stash without removing it', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'stash-apply.txt'), 'content');
      await repo.git.add('stash-apply.txt');
      await repo.git.raw(['stash', 'push', '-m', 'test apply']);

      const result = await stashApply(repo.git);

      expect(result.success).toBe(true);

      // File should be restored
      const content = await fs.readFile(path.join(repo.repoPath, 'stash-apply.txt'), 'utf-8');
      expect(content).toBe('content');

      // Stash should still exist
      const stashOutput = await repo.git.raw(['stash', 'list']);
      expect(stashOutput).toContain('test apply');
    });
  });
});

describe('Git Write Commands - Remote Operations', { timeout: 30_000 }, () => {
  let upstream: TestRepo;
  let clone: TestRepo;
  let initialMainCommit = '';

  beforeAll(async () => {
    // Create an upstream repo that allows pushes to the checked-out branch
    upstream = await createTestRepoWithCommit('git-upstream-');
    await upstream.git.addConfig('receive.denyCurrentBranch', 'ignore');

    // Clone it
    const clonePath = `${upstream.repoPath}-clone`;
    const { simpleGit } = await import('simple-git');
    await simpleGit().clone(upstream.repoPath, clonePath);

    const cloneGit = simpleGit(clonePath);
    await cloneGit.addConfig('user.name', 'Clone User');
    await cloneGit.addConfig('user.email', 'clone@test.local');
    await cloneGit.addConfig('commit.gpgsign', 'false');

    clone = {
      repoPath: clonePath,
      git: cloneGit,
      cleanup: () => fs.rm(clonePath, { recursive: true, force: true }),
    };
    initialMainCommit = (await upstream.git.revparse(['HEAD'])).trim();
  }, 30_000);

  beforeEach(async () => {
    // Keep each test deterministic without paying clone cost every time.
    await upstream.git.checkout('main');
    await upstream.git.raw(['reset', '--hard', initialMainCommit]);
    await upstream.git.clean('f', ['-d']);

    await clone.git.checkout('main');
    await clone.git.raw(['fetch', '--prune', 'origin']);
    await clone.git.raw(['reset', '--hard', 'origin/main']);
    await clone.git.clean('f', ['-d']);
  }, 30_000);

  afterAll(async () => {
    await clone.cleanup();
    await upstream.cleanup();
  });

  describe('fetch', () => {
    it('should fetch from remote', async () => {
      // Create a new commit on upstream
      await fs.writeFile(path.join(upstream.repoPath, 'upstream-new.txt'), 'new');
      await upstream.git.add('upstream-new.txt');
      await upstream.git.commit('upstream update');

      const result = await fetch(clone.git);

      expect(result.success).toBe(true);
      expect(result.remote).toBe('origin');
    });

    it('should fetch with prune', async () => {
      const result = await fetch(clone.git, undefined, { prune: true });

      expect(result.success).toBe(true);
    });
  });

  describe('pull', () => {
    it('should pull new changes from remote', async () => {
      // Add a new commit to upstream
      await fs.writeFile(path.join(upstream.repoPath, 'upstream-pull.txt'), 'pull-content');
      await upstream.git.add('upstream-pull.txt');
      await upstream.git.commit('upstream pull commit');

      const result = await pull(clone.git);

      expect(result.success).toBe(true);
      expect(result.updated).toBe(true);

      // Verify file exists in clone
      const content = await fs.readFile(path.join(clone.repoPath, 'upstream-pull.txt'), 'utf-8');
      expect(content).toBe('pull-content');
    });

    it('should report up-to-date when no changes', async () => {
      const result = await pull(clone.git);

      expect(result.success).toBe(true);
      expect(result.updated).toBe(false);
    });
  });

  describe('push', () => {
    it('should push commits to remote', async () => {
      await fs.writeFile(path.join(clone.repoPath, 'push-file.txt'), 'pushed');
      await clone.git.add('push-file.txt');
      await clone.git.commit('push commit');

      const result = await push(clone.git);

      expect(result.success).toBe(true);
      expect(result.remote).toBe('origin');

      // Verify commit landed in upstream (non-bare, so check ref log)
      const upstreamHead = (await upstream.git.revparse(['HEAD'])).trim();
      const cloneHead = (await clone.git.revparse(['HEAD'])).trim();
      expect(upstreamHead).toBe(cloneHead);
    });

    it('should push with set-upstream', async () => {
      // Create and push a new branch
      const branchName = `new-push-branch-${Date.now()}`;
      await clone.git.raw(['checkout', '-b', branchName]);
      await fs.writeFile(path.join(clone.repoPath, 'branch-push.txt'), 'branch');
      await clone.git.add('branch-push.txt');
      await clone.git.commit('branch push');

      const result = await push(clone.git, 'origin', branchName, {
        setUpstream: true,
      });

      expect(result.success).toBe(true);
    });

    it('should fail when pushing to a non-existent remote', async () => {
      const result = await push(clone.git, 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
