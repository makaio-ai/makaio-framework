import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { resolveLogRepoPath } from '../log-repo-path.js';
import { configureTestGit } from './git-test-utils.js';

/**
 * Integration tests using real git repositories.
 *
 * These tests exercise the actual `resolveLogRepoPath` function against
 * real git repos and worktrees — no mocking of git or fs.
 */
describe('resolveLogRepoPath', { timeout: 20_000 }, () => {
  let tmpDir: string;
  let repoPath: string;
  let worktreePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-repo-path-'));
    repoPath = path.join(tmpDir, 'repo');
    worktreePath = path.join(tmpDir, 'wt');

    // Initialize a real git repo with an initial commit
    await fs.mkdir(repoPath, { recursive: true });
    const git = simpleGit(repoPath);
    await git.init();
    await configureTestGit(repoPath);
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'hello');
    await git.add('.');
    await git.commit('initial');

    // Create a linked worktree
    await git.raw(['worktree', 'add', worktreePath, '-b', 'wt-branch']);
  }, 20_000);

  afterEach(async () => {
    // Clean up worktree before removing tmpDir
    try {
      const git = simpleGit(repoPath);
      await git.raw(['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // Ignore cleanup errors
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }, 20_000);

  it('returns repoPath when selectedWorktree is not provided', async () => {
    const result = await resolveLogRepoPath(repoPath);
    expect(result).toBe(repoPath);
  });

  it('accepts worktree from the same repository', async () => {
    const result = await resolveLogRepoPath(repoPath, worktreePath);
    expect(result).toBe(await fs.realpath(worktreePath));
  });

  it('rejects selectedWorktree from another repository', async () => {
    const otherRepo = path.join(tmpDir, 'other');
    await fs.mkdir(otherRepo, { recursive: true });
    const otherGit = simpleGit(otherRepo);
    await otherGit.init();
    await configureTestGit(otherRepo);
    await fs.writeFile(path.join(otherRepo, 'file.txt'), 'other');
    await otherGit.add('.');
    await otherGit.commit('initial');

    await expect(resolveLogRepoPath(repoPath, otherRepo)).rejects.toThrow(
      'selectedWorktree must belong to the same repository as repoPath',
    );
  });
});
