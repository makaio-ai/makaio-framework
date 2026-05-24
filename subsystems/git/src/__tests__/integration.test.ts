import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { simpleGit, type SimpleGit } from 'simple-git';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { GitSubjects } from '../namespace.js';
import { GitService } from '../git-service.js';
import { configureTestGit } from './git-test-utils.js';

describe('GitService Integration', { timeout: 20_000 }, () => {
  let bus: IMakaioBus;
  let gitService: GitService;
  let repoPath: string;
  let git: SimpleGit;

  beforeAll(async () => {
    bus = createBusInstance();
    gitService = new GitService(bus);
    await gitService.init();
  });

  afterAll(async () => {
    await gitService.destroy();
  });

  beforeEach(async () => {
    // Create temp repo with known state
    // Use realpath to resolve macOS /var -> /private/var symlink
    repoPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-integration-test-')));
    await bus.request(GitSubjects.initRepo, { path: repoPath });
    git = simpleGit(repoPath);
    await configureTestGit(repoPath);

    // Create initial commit
    await fs.writeFile(path.join(repoPath, 'README.md'), '# Test Project\n');
    await git.add('README.md');
    await git.commit('Initial commit');
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it('should provide consistent branch info across requests', async () => {
    const branch1 = await bus.request(GitSubjects.getBranch, { repoPath });
    const branch2 = await bus.request(GitSubjects.getBranch, { repoPath });

    expect(branch1.current).toBe('main');
    expect(branch2.current).toBe('main');
    expect(branch1.isDetached).toBe(false);
    expect(branch2.isDetached).toBe(false);
  });

  it('should allow querying commit by ref', async () => {
    const head = await bus.request(GitSubjects.getCommit, { repoPath, ref: 'HEAD' });
    const headExplicit = await bus.request(GitSubjects.getCommit, { repoPath });

    expect(head.hash).toBe(headExplicit.hash);
    expect(head.message).toBe('Initial commit');
    expect(head.author).toBe('Test User');
  });

  it('should return valid worktree for repo', async () => {
    const { worktrees } = await bus.request(GitSubjects.getWorktrees, { repoPath });

    expect(worktrees).toHaveLength(1);
    const mainWorktree = worktrees.find((w) => w.isMain);
    expect(mainWorktree).toBeDefined();
    expect(mainWorktree?.path).toBe(repoPath);
    expect(mainWorktree?.branch).toBe('main');
  });

  it('should handle multiple concurrent requests', async () => {
    const [branch, commit, status] = await Promise.all([
      bus.request(GitSubjects.getBranch, { repoPath }),
      bus.request(GitSubjects.getCommit, { repoPath }),
      bus.request(GitSubjects.getStatus, { repoPath }),
    ]);

    expect(branch.current).toBe('main');
    expect(commit.message).toBe('Initial commit');
    expect(status.staged).toHaveLength(0);
    expect(status.modified).toHaveLength(0);
    expect(status.untracked).toHaveLength(0);
  });

  it('should track file changes correctly', async () => {
    // Add untracked file
    await fs.writeFile(path.join(repoPath, 'new-file.txt'), 'new content');

    const status1 = await bus.request(GitSubjects.getStatus, { repoPath });
    expect(status1.untracked).toContain('new-file.txt');
    expect(status1.staged).toHaveLength(0);

    // Stage the file
    await git.add('new-file.txt');

    const status2 = await bus.request(GitSubjects.getStatus, { repoPath });
    expect(status2.staged).toContain('new-file.txt');
    expect(status2.untracked).not.toContain('new-file.txt');
  });

  it('should return correct log with multiple commits', async () => {
    // Add more commits
    await fs.writeFile(path.join(repoPath, 'file1.txt'), 'content1');
    await git.add('file1.txt');
    await git.commit('Add file1');

    await fs.writeFile(path.join(repoPath, 'file2.txt'), 'content2');
    await git.add('file2.txt');
    await git.commit('Add file2');

    const { commits } = await bus.request(GitSubjects.getLog, { repoPath, limit: 10 });

    expect(commits).toHaveLength(3);
    expect(commits[0].message).toBe('Add file2');
    expect(commits[1].message).toBe('Add file1');
    expect(commits[2].message).toBe('Initial commit');
  });
});
