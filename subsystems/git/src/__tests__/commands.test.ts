/**
 * Integration tests for git write commands: commit, branch, checkout.
 *
 * Tests use real temporary git repositories to verify actual git behavior.
 * No mocks - tests exercise real git operations.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepoWithCommit, type TestRepo } from './git-test-utils.js';
import { commitChanges } from '../commands/commit.js';
import { createBranch, deleteBranch } from '../commands/branch.js';
import { checkoutRef } from '../commands/checkout.js';

describe('Git Write Commands - Core', { timeout: 20_000 }, () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithCommit('git-cmd-');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe('commitChanges', () => {
    it('should create a commit with staged changes', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'new.txt'), 'content');
      await repo.git.add('new.txt');

      const result = await commitChanges(repo.git, 'add new file');

      expect(result.success).toBe(true);
      expect(result.hash).toBeDefined();
      expect(result.hash).toMatch(/^[0-9a-f]{40,64}$/i);
      expect(result.message).toBe('add new file');

      const log = await repo.git.log(['-1']);
      expect(log.latest?.message).toBe('add new file');
    });

    it('should not create a new commit when nothing is staged', async () => {
      const hashBefore = (await repo.git.revparse(['HEAD'])).trim();
      const result = await commitChanges(repo.git, 'empty commit');

      // Git may or may not throw for "nothing to commit" depending on version.
      // The important invariant: HEAD should not change.
      const hashAfter = (await repo.git.revparse(['HEAD'])).trim();
      if (result.success) {
        expect(hashAfter).toBe(hashBefore);
      } else {
        expect(result.error).toBeDefined();
      }
    });

    it('should allow empty commits with allowEmpty option', async () => {
      const result = await commitChanges(repo.git, 'empty commit', { allowEmpty: true });

      expect(result.success).toBe(true);
      expect(result.hash).toBeDefined();
    });

    it('should amend the previous commit', async () => {
      const originalLog = await repo.git.log(['-1']);
      const originalHash = originalLog.latest?.hash;

      const result = await commitChanges(repo.git, 'amended message', { amend: true });

      expect(result.success).toBe(true);
      expect(result.hash).not.toBe(originalHash);

      const log = await repo.git.log(['-1']);
      expect(log.latest?.message).toBe('amended message');
    });

    it('should set author override', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'authored.txt'), 'content');
      await repo.git.add('authored.txt');

      const result = await commitChanges(repo.git, 'authored commit', {
        author: 'Other User <other@test.local>',
      });

      expect(result.success).toBe(true);

      const log = await repo.git.log(['-1']);
      expect(log.latest?.author_name).toBe('Other User');
      expect(log.latest?.author_email).toBe('other@test.local');
    });
  });

  describe('createBranch', () => {
    it('should create a new branch at HEAD', async () => {
      const result = await createBranch(repo.git, 'feature-branch');

      expect(result.success).toBe(true);
      expect(result.branch).toBe('feature-branch');

      const branches = await repo.git.branchLocal();
      expect(branches.all).toContain('feature-branch');
    });

    it('should create a branch at a specific start point', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'second.txt'), 'content');
      await repo.git.add('second.txt');
      await repo.git.commit('second commit');

      const firstCommit = (await repo.git.log(['-2'])).all[1].hash;
      const result = await createBranch(repo.git, 'from-first', firstCommit);

      expect(result.success).toBe(true);

      const branchHash = (await repo.git.revparse([`refs/heads/from-first`])).trim();
      expect(branchHash).toBe(firstCommit);
    });

    it('should fail for duplicate branch name', async () => {
      await createBranch(repo.git, 'existing');
      const result = await createBranch(repo.git, 'existing');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('deleteBranch', () => {
    it('should delete a merged branch', async () => {
      await createBranch(repo.git, 'to-delete');

      const result = await deleteBranch(repo.git, 'to-delete');

      expect(result.success).toBe(true);
      expect(result.branch).toBe('to-delete');

      const branches = await repo.git.branchLocal();
      expect(branches.all).not.toContain('to-delete');
    });

    it('should fail to delete unmerged branch without force', async () => {
      await repo.git.raw(['checkout', '-b', 'unmerged']);
      await fs.writeFile(path.join(repo.repoPath, 'unmerged.txt'), 'content');
      await repo.git.add('unmerged.txt');
      await repo.git.commit('unmerged commit');
      await repo.git.checkout('main');

      const result = await deleteBranch(repo.git, 'unmerged', false);
      expect(result.success).toBe(false);
    });

    it('should force-delete unmerged branch', async () => {
      await repo.git.raw(['checkout', '-b', 'force-delete']);
      await fs.writeFile(path.join(repo.repoPath, 'force.txt'), 'content');
      await repo.git.add('force.txt');
      await repo.git.commit('force commit');
      await repo.git.checkout('main');

      const result = await deleteBranch(repo.git, 'force-delete', true);
      expect(result.success).toBe(true);
    });
  });

  describe('checkoutRef', () => {
    it('should checkout an existing branch', async () => {
      await createBranch(repo.git, 'other-branch');

      const result = await checkoutRef(repo.git, 'other-branch');

      expect(result.success).toBe(true);
      expect(result.target).toBe('other-branch');
      expect(result.created).toBe(false);

      const status = await repo.git.status();
      expect(status.current).toBe('other-branch');
    });

    it('should create and checkout a new branch', async () => {
      const result = await checkoutRef(repo.git, 'new-branch', { createBranch: true });

      expect(result.success).toBe(true);
      expect(result.target).toBe('new-branch');
      expect(result.created).toBe(true);

      const status = await repo.git.status();
      expect(status.current).toBe('new-branch');
    });

    it('should create branch from a specific start point', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'second.txt'), 'content');
      await repo.git.add('second.txt');
      await repo.git.commit('second');

      const firstHash = (await repo.git.log(['-2'])).all[1].hash;

      const result = await checkoutRef(repo.git, 'from-old', {
        createBranch: true,
        startPoint: firstHash,
      });

      expect(result.success).toBe(true);
      const currentHash = (await repo.git.revparse(['HEAD'])).trim();
      expect(currentHash).toBe(firstHash);
    });

    it('should fail for non-existent ref', async () => {
      const result = await checkoutRef(repo.git, 'nonexistent');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
