import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { GitSubjects } from '../namespace.js';
import { FsSubjects } from '@makaio/services-core/filesystem/namespace';
import { GitWatcher } from '../git-watcher.js';
import { createTestRepoWithCommit } from './git-test-utils.js';

describe('GitWatcher', { timeout: 30_000 }, () => {
  let bus: IMakaioBus;
  let watcher: GitWatcher;

  beforeEach(async () => {
    bus = createBusInstance();

    bus.on(FsSubjects.watch, (ctx) => {
      ctx.setResult({ success: true, watchId: ctx.payload.id });
    });
    bus.on(FsSubjects.unwatch, (ctx) => {
      ctx.setResult({ success: true });
    });

    watcher = new GitWatcher(bus);
    await watcher.init();
  });

  afterEach(async () => {
    await watcher.destroy();
  });

  it('parses commit messages with pipe characters', async () => {
    const repo = await createTestRepoWithCommit('git-watcher-message-test-');
    let unsubscribe: (() => void) | null = null;
    try {
      await bus.request(GitSubjects.addRepo, { repoPath: repo.repoPath });

      const commitEvents: Array<{ message: string }> = [];
      unsubscribe = bus.on(GitSubjects.commit, (ctx) => {
        commitEvents.push({ message: ctx.payload.message });
      });

      await fs.writeFile(path.join(repo.repoPath, 'pipe-message.txt'), 'with pipe\n');
      await repo.git.add('pipe-message.txt');
      await repo.git.commit('feat: subject with | delimiter');
      const branch = (await repo.git.branchLocal()).current;

      await bus.emit(FsSubjects.changed, {
        path: path.join(repo.repoPath, '.git', 'refs', 'heads', branch),
        kind: 'change',
      });

      await vi.waitUntil(() => commitEvents.length > 0, { timeout: 5000, interval: 50 });

      expect(commitEvents[0]?.message).toBe('feat: subject with | delimiter');
    } finally {
      unsubscribe?.();
      await repo.cleanup();
    }
  });

  it('falls back to parent watcher when the most specific watcher cannot interpret a path', async () => {
    const repo = await createTestRepoWithCommit('git-watcher-routing-test-');
    const worktreePath = path.join(path.dirname(repo.repoPath), `wt-${Date.now()}`);
    const worktreeName = path.basename(worktreePath);
    let unsubscribe: (() => void) | null = null;
    try {
      await repo.git.raw(['worktree', 'add', worktreePath, '-b', 'wt-routing-test']);
      await bus.request(GitSubjects.addRepo, { repoPath: repo.repoPath });
      await bus.request(GitSubjects.addRepo, { repoPath: worktreePath });

      const worktreeEvents: Array<{ name: string; event: string }> = [];
      unsubscribe = bus.on(GitSubjects.worktree, (ctx) => {
        worktreeEvents.push({ name: ctx.payload.name, event: ctx.payload.event });
      });

      await bus.emit(FsSubjects.changed, {
        path: path.join(repo.repoPath, '.git', 'worktrees', worktreeName),
        kind: 'delete',
      });

      await vi.waitUntil(() => worktreeEvents.length > 0, { timeout: 5000, interval: 50 });

      expect(worktreeEvents[0]).toMatchObject({ name: worktreeName, event: 'removed' });
    } finally {
      unsubscribe?.();
      try {
        await repo.git.raw(['worktree', 'remove', '--force', worktreePath]);
      } catch {
        // Best-effort cleanup for worktree fixture.
      }
      await repo.cleanup();
    }
  });

  it('fails addRepo with a descriptive error when .git gitdir reference is invalid', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-watcher-invalid-gitdir-'));
    try {
      await fs.writeFile(path.join(tempDir, '.git'), 'gitdir: ./missing-git-dir\n');
      const response = await bus.request(GitSubjects.addRepo, { repoPath: tempDir });

      expect(response.success).toBe(false);
      expect(response.error).toContain('path does not exist');
      expect(response.error).toContain('.git');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('interprets worktree gitdir file create/delete as added/removed', () => {
    const createResult = watcher.interpretChange('/repo/.git', {
      path: '/repo/.git/worktrees/wt-feature/gitdir',
      kind: 'create',
    });
    const deleteResult = watcher.interpretChange('/repo/.git', {
      path: '/repo/.git/worktrees/wt-feature/gitdir',
      kind: 'delete',
    });

    expect(createResult).toEqual({ type: 'worktree-added', worktree: 'wt-feature' });
    expect(deleteResult).toEqual({ type: 'worktree-removed', worktree: 'wt-feature' });
  });

  it('waits for repo unwatch operations before destroy resolves', async () => {
    const repo = await createTestRepoWithCommit('git-watcher-destroy-test-');
    const unwatchReleased = Promise.withResolvers<void>();
    let unwatchCalls = 0;
    const localBus = createBusInstance();
    localBus.on(FsSubjects.watch, (ctx) => {
      ctx.setResult({ success: true, watchId: ctx.payload.id });
    });
    localBus.on(FsSubjects.unwatch, async (ctx) => {
      unwatchCalls += 1;
      await unwatchReleased.promise;
      ctx.setResult({ success: true });
    });
    const localWatcher = new GitWatcher(localBus);
    await localWatcher.init();

    try {
      await localBus.request(GitSubjects.addRepo, { repoPath: repo.repoPath });

      const destroyPromise = localWatcher.destroy();
      await Promise.resolve();

      expect(unwatchCalls).toBe(1);

      let settled = false;
      void destroyPromise.then(() => {
        settled = true;
      });
      await Promise.resolve();

      expect(settled).toBe(false);

      unwatchReleased.resolve();
      await destroyPromise;
    } finally {
      await localWatcher.destroy();
      await repo.cleanup();
    }
  });
});
