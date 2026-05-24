/**
 * Integration tests for git write commands: merge, rebase, stash.
 *
 * Tests use real temporary git repositories to verify actual git behavior.
 * No mocks - tests exercise real git operations.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestRepoWithCommit, type TestRepo } from './git-test-utils.js';
import { mergeBranch, abortMerge } from '../commands/merge.js';
import { rebase } from '../commands/rebase.js';
import { stashPush, stashPop, stashList, stashDrop } from '../commands/stash.js';

describe('Git Write Commands - Complex Operations', { timeout: 30_000 }, () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithCommit('git-cmd-cx-');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  describe('mergeBranch', () => {
    it('should fast-forward merge', async () => {
      await repo.git.raw(['checkout', '-b', 'feature']);
      await fs.writeFile(path.join(repo.repoPath, 'feature.txt'), 'content');
      await repo.git.add('feature.txt');
      await repo.git.commit('feature commit');
      await repo.git.checkout('main');

      const result = await mergeBranch(repo.git, 'feature');

      expect(result.success).toBe(true);
      expect(result.mergeCommit).toBeUndefined();
      expect(result.fastForward).toBe(true);
    });

    it('should create a merge commit with --no-ff', async () => {
      await repo.git.raw(['checkout', '-b', 'feature-noff']);
      await fs.writeFile(path.join(repo.repoPath, 'feature-noff.txt'), 'content');
      await repo.git.add('feature-noff.txt');
      await repo.git.commit('feature noff commit');
      await repo.git.checkout('main');

      const headBefore = (await repo.git.revparse(['HEAD'])).trim();
      const result = await mergeBranch(repo.git, 'feature-noff', { noFf: true });

      expect(result.success).toBe(true);
      expect(result.mergeCommit).toBeDefined();
      expect(result.mergeCommit).not.toBe(headBefore);
    });

    it('should detect merge conflicts', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'conflict.txt'), 'main content');
      await repo.git.add('conflict.txt');
      await repo.git.commit('main change');

      await repo.git.raw(['checkout', '-b', 'conflict-branch', 'HEAD~1']);
      await fs.writeFile(path.join(repo.repoPath, 'conflict.txt'), 'branch content');
      await repo.git.add('conflict.txt');
      await repo.git.commit('branch change');

      await repo.git.checkout('main');
      const result = await mergeBranch(repo.git, 'conflict-branch');

      expect(result.success).toBe(false);
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts).toContain('conflict.txt');

      await abortMerge(repo.git);
    });

    it('should squash merge without creating a merge commit', async () => {
      await repo.git.raw(['checkout', '-b', 'feature-squash']);
      await fs.writeFile(path.join(repo.repoPath, 'squash1.txt'), 'one');
      await repo.git.add('squash1.txt');
      await repo.git.commit('squash commit 1');
      await fs.writeFile(path.join(repo.repoPath, 'squash2.txt'), 'two');
      await repo.git.add('squash2.txt');
      await repo.git.commit('squash commit 2');
      await repo.git.checkout('main');

      const headBefore = (await repo.git.revparse(['HEAD'])).trim();
      const result = await mergeBranch(repo.git, 'feature-squash', {
        squash: true,
      });

      expect(result.success).toBe(true);
      expect(result.fastForward).toBe(false);
      // HEAD should not have moved (squash stages but doesn't commit)
      const headAfter = (await repo.git.revparse(['HEAD'])).trim();
      expect(headAfter).toBe(headBefore);

      // Files should be staged
      const status = await repo.git.status();
      expect(status.staged).toContain('squash1.txt');
      expect(status.staged).toContain('squash2.txt');
    });

    it('should fail with --ff-only when fast-forward is not possible', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'main-file.txt'), 'main');
      await repo.git.add('main-file.txt');
      await repo.git.commit('main change');

      await repo.git.raw(['checkout', '-b', 'divergent', 'HEAD~1']);
      await fs.writeFile(path.join(repo.repoPath, 'divergent-file.txt'), 'divergent');
      await repo.git.add('divergent-file.txt');
      await repo.git.commit('divergent change');
      await repo.git.checkout('main');

      const result = await mergeBranch(repo.git, 'divergent', { ffOnly: true });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('abortMerge', () => {
    it('should abort an in-progress merge', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'conflict.txt'), 'main');
      await repo.git.add('conflict.txt');
      await repo.git.commit('main');

      await repo.git.raw(['checkout', '-b', 'conflict-abort', 'HEAD~1']);
      await fs.writeFile(path.join(repo.repoPath, 'conflict.txt'), 'branch');
      await repo.git.add('conflict.txt');
      await repo.git.commit('branch');
      await repo.git.checkout('main');

      await mergeBranch(repo.git, 'conflict-abort');
      const result = await abortMerge(repo.git);

      expect(result.success).toBe(true);

      const status = await repo.git.status();
      expect(status.conflicted).toHaveLength(0);
    });
  });

  describe('rebase', () => {
    it('should rebase current branch onto target', async () => {
      await repo.git.raw(['checkout', '-b', 'rebase-feature']);
      await fs.writeFile(path.join(repo.repoPath, 'feature.txt'), 'feature');
      await repo.git.add('feature.txt');
      await repo.git.commit('feature on branch');

      await repo.git.checkout('main');
      await fs.writeFile(path.join(repo.repoPath, 'main-update.txt'), 'main');
      await repo.git.add('main-update.txt');
      await repo.git.commit('main update');

      await repo.git.checkout('rebase-feature');
      const result = await rebase(repo.git, 'main');

      expect(result.success).toBe(true);

      const log = await repo.git.log(['-3']);
      expect(log.all[0].message).toBe('feature on branch');
      expect(log.all[1].message).toBe('main update');
    });

    it('should auto-stash dirty working tree', async () => {
      await repo.git.raw(['checkout', '-b', 'rebase-stash']);
      await fs.writeFile(path.join(repo.repoPath, 'feature.txt'), 'feature');
      await repo.git.add('feature.txt');
      await repo.git.commit('feature');

      await repo.git.checkout('main');
      await fs.writeFile(path.join(repo.repoPath, 'main-update.txt'), 'main');
      await repo.git.add('main-update.txt');
      await repo.git.commit('main update');

      await repo.git.checkout('rebase-stash');
      // Modify a tracked file (git stash only stashes tracked changes by default)
      await fs.writeFile(path.join(repo.repoPath, 'base.txt'), 'modified base');

      const result = await rebase(repo.git, 'main', { autoStash: true });

      expect(result.success).toBe(true);
      expect(result.autoStashed).toBe(true);
      expect(result.stashPopped).toBe(true);

      const baseContent = await fs.readFile(path.join(repo.repoPath, 'base.txt'), 'utf-8');
      expect(baseContent).toBe('modified base');
    });

    it('should auto-stash untracked files and restore them after rebase', async () => {
      await repo.git.raw(['checkout', '-b', 'rebase-untracked']);
      await fs.writeFile(path.join(repo.repoPath, 'feature.txt'), 'feature');
      await repo.git.add('feature.txt');
      await repo.git.commit('feature');

      await repo.git.checkout('main');
      await fs.writeFile(path.join(repo.repoPath, 'main-update.txt'), 'main');
      await repo.git.add('main-update.txt');
      await repo.git.commit('main update');

      await repo.git.checkout('rebase-untracked');
      await fs.writeFile(path.join(repo.repoPath, 'untracked.txt'), 'local draft');

      const result = await rebase(repo.git, 'main', { autoStash: true });

      expect(result.success).toBe(true);
      expect(result.autoStashed).toBe(true);
      expect(result.stashPopped).toBe(true);

      const untrackedContent = await fs.readFile(path.join(repo.repoPath, 'untracked.txt'), 'utf-8');
      expect(untrackedContent).toBe('local draft');
    });

    it('should abort a rebase', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'conflict.txt'), 'main');
      await repo.git.add('conflict.txt');
      await repo.git.commit('main conflict');

      await repo.git.raw(['checkout', '-b', 'rebase-conflict', 'HEAD~1']);
      await fs.writeFile(path.join(repo.repoPath, 'conflict.txt'), 'branch');
      await repo.git.add('conflict.txt');
      await repo.git.commit('branch conflict');

      const rebaseResult = await rebase(repo.git, 'main');
      expect(rebaseResult.success).toBe(false);

      const abortResult = await rebase(repo.git, '', { action: 'abort' });
      expect(abortResult.success).toBe(true);
    });
  });

  describe('stash', () => {
    it('should push and pop changes', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'stash-file.txt'), 'stash me');

      const pushResult = await stashPush(repo.git, { includeUntracked: true });
      expect(pushResult.success).toBe(true);
      expect(pushResult.ref).toBe('stash@{0}');

      const exists = await fs.access(path.join(repo.repoPath, 'stash-file.txt')).then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);

      const popResult = await stashPop(repo.git);
      expect(popResult.success).toBe(true);

      const content = await fs.readFile(path.join(repo.repoPath, 'stash-file.txt'), 'utf-8');
      expect(content).toBe('stash me');
    });

    it('should list stash entries with branch and date', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'stash1.txt'), 'one');
      await repo.git.add('stash1.txt');
      await stashPush(repo.git, { message: 'first stash' });

      await fs.writeFile(path.join(repo.repoPath, 'stash2.txt'), 'two');
      await repo.git.add('stash2.txt');
      await stashPush(repo.git, { message: 'second stash' });

      const listResult = await stashList(repo.git);
      expect(listResult.success).toBe(true);
      expect(listResult.entries).toHaveLength(2);
      expect(listResult.entries![0].index).toBe(0);
      expect(listResult.entries![1].index).toBe(1);

      // Branch should be extracted from stash subject
      expect(listResult.entries![0].branch).toBe('main');
      expect(listResult.entries![1].branch).toBe('main');

      // Date should be a valid ISO 8601 string
      expect(new Date(listResult.entries![0].date).getTime()).toBeGreaterThan(0);
      expect(new Date(listResult.entries![1].date).getTime()).toBeGreaterThan(0);
    });

    it('should drop a stash entry', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'drop.txt'), 'drop me');
      await repo.git.add('drop.txt');
      await stashPush(repo.git, { message: 'to drop' });

      const dropResult = await stashDrop(repo.git);
      expect(dropResult.success).toBe(true);

      const listResult = await stashList(repo.git);
      expect(listResult.entries).toHaveLength(0);
    });

    it('should stash with custom message', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'msg.txt'), 'msg');
      await repo.git.add('msg.txt');

      await stashPush(repo.git, { message: 'my custom stash' });

      const listResult = await stashList(repo.git);
      expect(listResult.entries).toHaveLength(1);
      expect(listResult.entries![0].message).toContain('my custom stash');
    });

    it('should return error when there are no local changes to stash', async () => {
      const result = await stashPush(repo.git);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No local changes to stash');
      expect(result.ref).toBeUndefined();
    });

    it('should not stash untracked-only changes unless includeUntracked is true', async () => {
      await fs.writeFile(path.join(repo.repoPath, 'untracked-only.txt'), 'draft');

      const withoutUntracked = await stashPush(repo.git);
      expect(withoutUntracked.success).toBe(false);
      expect(withoutUntracked.error).toBe('No local changes to stash');

      const withUntracked = await stashPush(repo.git, { includeUntracked: true, message: 'stash untracked' });
      expect(withUntracked.success).toBe(true);
      expect(withUntracked.ref).toBe('stash@{0}');
    });

    it('should fail to pop when no stash exists', async () => {
      const result = await stashPop(repo.git);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
