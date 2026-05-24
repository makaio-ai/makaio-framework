import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { GitSubjects } from '../namespace.js';
import { GitService } from '../git-service.js';
import { configureTestGit, createRepoWithTwoCommits, createTestRepoWithCommit } from './git-test-utils.js';

let bus: IMakaioBus;

describe('GitService', { timeout: 30_000 }, () => {
  let gitService: GitService;

  beforeEach(async () => {
    bus = createBusInstance();
    gitService = new GitService(bus);
    await gitService.init();
  });

  afterEach(async () => {
    await gitService.destroy();
  });

  describe('getBranch', () => {
    it('should return current branch info', async () => {
      const response = await bus.request(GitSubjects.getBranch, {});

      expect(response.current).toBeDefined();
      expect(typeof response.current).toBe('string');
      expect(typeof response.isDetached).toBe('boolean');
    });

    it('should accept repoPath parameter', async () => {
      const response = await bus.request(GitSubjects.getBranch, {
        repoPath: process.cwd(),
      });

      expect(response.current).toBeDefined();
    });
  });

  describe('getCommit', () => {
    it('should return HEAD commit info by default', async () => {
      const response = await bus.request(GitSubjects.getCommit, {});

      expect(response.hash).toBeDefined();
      expect(response.hash.length).toBeGreaterThanOrEqual(7);
      expect(response.message).toBeDefined();
      expect(response.author).toBeDefined();
      expect(response.email).toBeDefined();
      expect(response.date).toBeDefined();
    });

    it('should accept ref parameter', async () => {
      const response = await bus.request(GitSubjects.getCommit, {
        ref: 'HEAD',
      });

      expect(response.hash).toBeDefined();
    });
  });

  describe('getStatus', () => {
    it('should return status arrays', async () => {
      const response = await bus.request(GitSubjects.getStatus, {});

      expect(Array.isArray(response.staged)).toBe(true);
      expect(Array.isArray(response.modified)).toBe(true);
      expect(Array.isArray(response.untracked)).toBe(true);
      expect(Array.isArray(response.conflicted)).toBe(true);
    });
  });

  describe('getWorktrees', () => {
    it('should return worktrees array', async () => {
      const response = await bus.request(GitSubjects.getWorktrees, {});

      expect(Array.isArray(response.worktrees)).toBe(true);
      expect(response.worktrees.length).toBeGreaterThan(0);

      const main = response.worktrees.find((w) => w.isMain);
      expect(main).toBeDefined();
      expect(main?.path).toBeDefined();
      expect(main?.branch).toBeDefined();
    });
  });

  describe('getRemotes', () => {
    it('should return remotes array', async () => {
      const response = await bus.request(GitSubjects.getRemotes, {});

      expect(Array.isArray(response.remotes)).toBe(true);
      if (response.remotes.length > 0) {
        expect(response.remotes[0].name).toBeDefined();
        expect(response.remotes[0].fetchUrl).toBeDefined();
      }
    });
  });

  describe('getDefaultBranch', () => {
    it('should return default branch', async () => {
      const response = await bus.request(GitSubjects.getDefaultBranch, {});

      expect(response.branch).toBeDefined();
      expect(typeof response.branch).toBe('string');
      expect(response.branch.length).toBeGreaterThan(0);
    });
  });

  describe('getLog', () => {
    it('should return commit history with refs', async () => {
      const response = await bus.request(GitSubjects.getLog, {});

      expect(Array.isArray(response.commits)).toBe(true);
      expect(response.commits.length).toBeGreaterThan(0);

      // Verify commit structure
      const commit = response.commits[0];
      expect(commit.hash).toBeDefined();
      expect(commit.shortHash).toBeDefined();
      expect(commit.message).toBeDefined();
      expect(commit.author).toBeDefined();
      expect(commit.email).toBeDefined();
      expect(commit.date).toBeDefined();
      expect(Array.isArray(commit.parents)).toBe(true);

      // Verify refs structure
      expect(response.refs).toBeDefined();
      expect(response.refs.branches).toBeDefined();
      expect(response.refs.remoteBranches).toBeDefined();
      expect(response.refs.tags).toBeDefined();
      expect(response.refs.HEAD).toBeDefined();

      // Verify truncated flag
      expect(typeof response.truncated).toBe('boolean');
    });

    it('should respect limit parameter', async () => {
      const response = await bus.request(GitSubjects.getLog, {
        limit: 5,
      });

      expect(response.commits.length).toBeLessThanOrEqual(5);
    });

    it('should filter by branches', async () => {
      const fs = await import('node:fs/promises');
      const { simpleGit } = await import('simple-git');

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-log-branch-test-'));
      const repoPath = tmpDir;

      try {
        // Initialize a repo with at least one commit
        await bus.request(GitSubjects.initRepo, { path: repoPath });
        const git = simpleGit(repoPath);
        await configureTestGit(repoPath);
        await fs.writeFile(`${repoPath}/initial.txt`, 'Initial content');
        await git.add('.');
        await git.commit('Initial commit');

        // Create a new branch and add a commit only to it
        await git.branch(['new-feature']);
        await git.checkout('new-feature');
        await fs.writeFile(`${repoPath}/feature.txt`, 'Feature content');
        await git.add('.');
        await git.commit('Feature commit');

        // Create another branch and commit
        await git.checkout('main');
        await git.branch(['other-feature']);
        await git.checkout('other-feature');
        await fs.writeFile(`${repoPath}/other.txt`, 'Other content');
        await git.add('.');
        await git.commit('Other commit');

        // Switch back to main
        await git.checkout('main');

        // Helper function to request log with repoPath
        const getLog = async (
          limit?: number,
          filters?: {
            searchQuery?: string;
            author?: string;
            branches?: string[];
            branchMode?: 'all' | 'specific';
            baseBranch?: string;
          },
        ) => {
          return bus.request(GitSubjects.getLog, {
            repoPath,
            limit,
            filters,
          });
        };

        // Test 'all' mode (union)
        const resultAll = await getLog(undefined, {
          branches: ['new-feature', 'other-feature'],
          branchMode: 'all',
        });

        const messagesAll = resultAll.commits.map((c) => c.message);
        expect(messagesAll).toContain('Feature commit');
        expect(messagesAll).toContain('Other commit');
        expect(messagesAll).toContain('Initial commit'); // Should also be included as it's a common ancestor

        // Test 'specific' mode (unique to branches)
        // Should see feature commits but NOT main commits if we exclude main
        const resultSpecific = await getLog(undefined, {
          branches: ['new-feature'],
          branchMode: 'specific',
          baseBranch: 'main',
        });

        const messagesSpecific = resultSpecific.commits.map((c) => c.message);
        expect(messagesSpecific).toContain('Feature commit');
        expect(messagesSpecific).not.toContain('Initial commit'); // Should be excluded by --not main
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should filter by searchQuery', async () => {
      const fs = await import('node:fs/promises');
      const { simpleGit } = await import('simple-git');

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-search-test-'));
      const repoPath = tmpDir;

      try {
        // Create repo with known commit messages
        await bus.request(GitSubjects.initRepo, { path: repoPath });
        const git = simpleGit(repoPath);
        await configureTestGit(repoPath);

        await fs.writeFile(`${repoPath}/file1.txt`, 'content1');
        await git.add('.');
        await git.commit('feat: add feature one');

        await fs.writeFile(`${repoPath}/file2.txt`, 'content2');
        await git.add('.');
        await git.commit('fix: bug fix for issue');

        await fs.writeFile(`${repoPath}/file3.txt`, 'content3');
        await git.add('.');
        await git.commit('feat: add feature two');

        // Search for 'feat' - should match 2 commits
        const response = await bus.request(GitSubjects.getLog, {
          repoPath,
          limit: 100,
          filters: {
            searchQuery: 'feat',
          },
        });

        expect(response.commits.length).toBe(2);
        response.commits.forEach((commit) => {
          expect(commit.message.toLowerCase()).toContain('feat');
        });

        // Search for 'fix' - should match 1 commit
        const fixResponse = await bus.request(GitSubjects.getLog, {
          repoPath,
          limit: 100,
          filters: {
            searchQuery: 'fix',
          },
        });

        expect(fixResponse.commits.length).toBe(1);
        expect(fixResponse.commits[0].message).toContain('fix');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should filter by multiple paths', async () => {
      const { repoPath, git } = await createRepoWithInitialCommit();
      const fs = await import('node:fs/promises');

      try {
        await fs.writeFile(path.join(repoPath, 'alpha.txt'), 'alpha');
        await git.add('alpha.txt');
        await git.commit('add alpha');

        await fs.writeFile(path.join(repoPath, 'beta.txt'), 'beta');
        await git.add('beta.txt');
        await git.commit('add beta');

        const response = await bus.request(GitSubjects.getLog, {
          repoPath,
          limit: 50,
          filters: {
            paths: ['alpha.txt', 'beta.txt'],
          },
        });

        const messages = response.commits.map((commit) => commit.message);
        expect(messages).toContain('add alpha');
        expect(messages).toContain('add beta');
        expect(messages).not.toContain('initial');
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    it('should honor ref when filtering by multiple paths', async () => {
      const fs = await import('node:fs/promises');
      const { simpleGit } = await import('simple-git');
      const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-git-log-ref-'));

      try {
        await bus.request(GitSubjects.initRepo, { path: repoPath });
        const git = simpleGit(repoPath);
        await configureTestGit(repoPath);

        await fs.writeFile(path.join(repoPath, 'alpha.txt'), 'alpha');
        await fs.writeFile(path.join(repoPath, 'beta.txt'), 'beta');
        await git.add(['alpha.txt', 'beta.txt']);
        await git.commit('initial');
        const initialHash = (await git.revparse(['HEAD'])).trim();

        await fs.writeFile(path.join(repoPath, 'alpha.txt'), 'alpha updated');
        await git.add('alpha.txt');
        await git.commit('update alpha');

        const response = await bus.request(GitSubjects.getLog, {
          repoPath,
          limit: 50,
          ref: initialHash,
          filters: {
            paths: ['alpha.txt', 'beta.txt'],
          },
        });

        const messages = response.commits.map((commit) => commit.message);
        expect(messages).toContain('initial');
        expect(messages).not.toContain('update alpha');
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    it('should filter by author', async () => {
      const response = await bus.request(GitSubjects.getLog, {
        limit: 10,
        filters: {
          author: 'chris',
        },
      });

      // Should return commits (assuming there are commits by chris)
      expect(Array.isArray(response.commits)).toBe(true);
    });

    it('should scope log to worktree branch when selectedWorktree is set', async () => {
      const fs = await import('node:fs/promises');
      const { simpleGit } = await import('simple-git');

      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-wt-log-'));
      const worktreePath = path.join(tmpDir, 'wt-feature');

      try {
        // Create a repo with initial commit on main
        await bus.request(GitSubjects.initRepo, { path: tmpDir });
        const git = simpleGit(tmpDir);
        await configureTestGit(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'main.txt'), 'main content');
        await git.add('.');
        await git.commit('Initial commit on main');

        // Create a worktree on a new branch BEFORE adding more main commits
        await bus.request(GitSubjects.createWorktree, {
          repoPath: tmpDir,
          path: worktreePath,
          branch: 'feature',
          createBranch: true,
        });

        // Add a commit only on main (after worktree branched off)
        await fs.writeFile(path.join(tmpDir, 'main2.txt'), 'main only');
        await git.add('.');
        await git.commit('Second commit on main');

        // Add a commit only in the worktree
        const wtGit = simpleGit(worktreePath);
        await fs.writeFile(path.join(worktreePath, 'feature.txt'), 'feature content');
        await wtGit.add('.');
        await wtGit.commit('Feature commit in worktree');

        // Log WITHOUT worktree filter — should see main's commits
        const mainLog = await bus.request(GitSubjects.getLog, {
          repoPath: tmpDir,
          limit: 50,
        });
        const mainMessages = mainLog.commits.map((c) => c.message);
        expect(mainMessages).toContain('Second commit on main');
        expect(mainMessages).not.toContain('Feature commit in worktree');

        // Log WITH worktree filter — should see worktree branch commits
        const wtLog = await bus.request(GitSubjects.getLog, {
          repoPath: tmpDir,
          limit: 50,
          filters: { selectedWorktree: worktreePath },
        });
        const wtMessages = wtLog.commits.map((c) => c.message);
        expect(wtMessages).toContain('Feature commit in worktree');
        expect(wtMessages).toContain('Initial commit on main'); // ancestor
        expect(wtMessages).not.toContain('Second commit on main'); // only on main
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should reject selectedWorktree from a different repository', async () => {
      const fs = await import('node:fs/promises');
      const { simpleGit } = await import('simple-git');

      const repoADir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-log-repo-a-'));
      const repoBDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-log-repo-b-'));

      try {
        await bus.request(GitSubjects.initRepo, { path: repoADir });
        const repoAGit = simpleGit(repoADir);
        await configureTestGit(repoADir);
        await fs.writeFile(path.join(repoADir, 'a.txt'), 'a');
        await repoAGit.add('.');
        await repoAGit.commit('repo a commit');

        await bus.request(GitSubjects.initRepo, { path: repoBDir });
        const repoBGit = simpleGit(repoBDir);
        await configureTestGit(repoBDir);
        await fs.writeFile(path.join(repoBDir, 'b.txt'), 'b');
        await repoBGit.add('.');
        await repoBGit.commit('repo b commit');

        await expect(
          bus.request(GitSubjects.getLog, {
            repoPath: repoADir,
            filters: { selectedWorktree: repoBDir },
          }),
        ).rejects.toThrow('selectedWorktree must belong to the same repository as repoPath');
      } finally {
        await fs.rm(repoADir, { recursive: true, force: true });
        await fs.rm(repoBDir, { recursive: true, force: true });
      }
    });
  });

  describe('getFileAtRevision', () => {
    it('should return file content at HEAD', async () => {
      const { repoPath, git } = await createRepoWithInitialCommit();
      const fs = await import('node:fs/promises');

      try {
        // Modify file and commit
        await fs.writeFile(path.join(repoPath, 'base.txt'), 'updated content\n');
        await git.add('base.txt');
        await git.commit('update base');

        const response = await bus.request(GitSubjects.getFileAtRevision, {
          repoPath,
          path: 'base.txt',
          ref: 'HEAD',
        });

        expect(response.content).toBe('updated content\n');
        expect(response.isBinary).toBe(false);
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    it('should return file content at specific commit', async () => {
      const { repoPath, git } = await createRepoWithInitialCommit();
      const fs = await import('node:fs/promises');

      try {
        // Get initial commit hash
        const log = await git.log({ maxCount: 1 });
        const initialHash = log.latest?.hash;

        // Modify file and commit
        await fs.writeFile(path.join(repoPath, 'base.txt'), 'updated content\n');
        await git.add('base.txt');
        await git.commit('update base');

        // Get file at initial commit (should have old content)
        const response = await bus.request(GitSubjects.getFileAtRevision, {
          repoPath,
          path: 'base.txt',
          ref: initialHash!,
        });

        expect(response.content).toBe('base\n');
        expect(response.isBinary).toBe(false);
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    it('should handle file paths with directories', async () => {
      const { repoPath, git } = await createRepoWithInitialCommit();
      const fs = await import('node:fs/promises');

      try {
        // Create nested directory with file
        await fs.mkdir(path.join(repoPath, 'src', 'utils'), { recursive: true });
        await fs.writeFile(path.join(repoPath, 'src', 'utils', 'helper.ts'), 'export const foo = 1;');
        await git.add('.');
        await git.commit('add nested file');

        const response = await bus.request(GitSubjects.getFileAtRevision, {
          repoPath,
          path: 'src/utils/helper.ts',
          ref: 'HEAD',
        });

        expect(response.content).toBe('export const foo = 1;');
        expect(response.isBinary).toBe(false);
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });

    it('should throw for non-existent file', async () => {
      const { repoPath } = await createRepoWithInitialCommit();
      const fs = await import('node:fs/promises');

      try {
        await expect(
          bus.request(GitSubjects.getFileAtRevision, {
            repoPath,
            path: 'nonexistent-file.txt',
            ref: 'HEAD',
          }),
        ).rejects.toThrow();
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true });
      }
    });
  });

  describe('getFileAtCommit', () => {
    it('should return file content at an existing commit', async () => {
      const { repoPath, git, cleanup } = await createTestRepoWithCommit();

      try {
        const log = await git.log({ maxCount: 1 });
        const commitHash = log.latest!.hash;

        const response = await bus.request(GitSubjects.getFileAtCommit, {
          repoPath,
          filePath: 'base.txt',
          commitHash,
        });

        expect(response.content).toBe('base\n');
        expect(response.isBinary).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('should return null content when file did not exist at commit', async () => {
      const { repoPath, firstCommitHash, cleanup } = await createRepoWithTwoCommits(
        'new-file.txt',
        'new content\n',
        'add new-file',
      );

      try {
        // new-file.txt did not exist at the first commit.
        const response = await bus.request(GitSubjects.getFileAtCommit, {
          repoPath,
          filePath: 'new-file.txt',
          commitHash: firstCommitHash,
        });

        expect(response.content).toBeNull();
        expect(response.isBinary).toBe(false);
      } finally {
        await cleanup();
      }
    });

    it('should return null content for a completely non-existent file', async () => {
      const { repoPath, cleanup } = await createTestRepoWithCommit();

      try {
        const response = await bus.request(GitSubjects.getFileAtCommit, {
          repoPath,
          filePath: 'does-not-exist.txt',
          commitHash: 'HEAD',
        });

        expect(response.content).toBeNull();
        expect(response.isBinary).toBe(false);
      } finally {
        await cleanup();
      }
    });
  });

  describe('getBlobHashAtCommit', () => {
    it('should return a blob hash for an existing file at a commit', async () => {
      const { repoPath, git, cleanup } = await createTestRepoWithCommit();

      try {
        const log = await git.log({ maxCount: 1 });
        const commitHash = log.latest!.hash;

        const response = await bus.request(GitSubjects.getBlobHashAtCommit, {
          repoPath,
          filePath: 'base.txt',
          commitHash,
        });

        expect(response.blobHash).not.toBeNull();
        // Git blob hashes are 40-character hex strings
        expect(response.blobHash).toMatch(/^[0-9a-f]{40}$/);
      } finally {
        await cleanup();
      }
    });

    it('should return null blob hash when file did not exist at commit', async () => {
      const { repoPath, firstCommitHash, cleanup } = await createRepoWithTwoCommits(
        'added-later.txt',
        'content\n',
        'add added-later',
      );

      try {
        const response = await bus.request(GitSubjects.getBlobHashAtCommit, {
          repoPath,
          filePath: 'added-later.txt',
          commitHash: firstCommitHash,
        });

        expect(response.blobHash).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it('should return same blob hash for identical file content across commits', async () => {
      const { repoPath, firstCommitHash, secondCommitHash, cleanup } = await createRepoWithTwoCommits(
        'other.txt',
        'other\n',
        'add other',
      );

      try {
        const [hashAtFirst, hashAtSecond] = await Promise.all([
          bus.request(GitSubjects.getBlobHashAtCommit, {
            repoPath,
            filePath: 'base.txt',
            commitHash: firstCommitHash,
          }),
          bus.request(GitSubjects.getBlobHashAtCommit, {
            repoPath,
            filePath: 'base.txt',
            commitHash: secondCommitHash,
          }),
        ]);

        // Same content → same blob hash
        expect(hashAtFirst.blobHash).not.toBeNull();
        expect(hashAtFirst.blobHash).toBe(hashAtSecond.blobHash);
      } finally {
        await cleanup();
      }
    });

    it('should return different blob hashes when file content changes', async () => {
      const { repoPath, firstCommitHash, secondCommitHash, cleanup } = await createRepoWithTwoCommits(
        'base.txt',
        'modified content\n',
        'modify base',
      );

      try {
        const [hashAtFirst, hashAtSecond] = await Promise.all([
          bus.request(GitSubjects.getBlobHashAtCommit, {
            repoPath,
            filePath: 'base.txt',
            commitHash: firstCommitHash,
          }),
          bus.request(GitSubjects.getBlobHashAtCommit, {
            repoPath,
            filePath: 'base.txt',
            commitHash: secondCommitHash,
          }),
        ]);

        expect(hashAtFirst.blobHash).not.toBeNull();
        expect(hashAtSecond.blobHash).not.toBeNull();
        expect(hashAtFirst.blobHash).not.toBe(hashAtSecond.blobHash);
      } finally {
        await cleanup();
      }
    });
  });

  describe('initRepo', () => {
    it('should initialize a new git repository', async () => {
      // Create temp directory
      const tmpDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'makaio-test-')));

      try {
        const response = await bus.request(GitSubjects.initRepo, {
          path: tmpDir,
        });

        expect(response.success).toBe(true);
        expect(response.path).toBe(tmpDir);
        expect(response.defaultBranch).toBe('main');

        // Verify .git directory was created
        const fs = await import('node:fs/promises');
        const gitDir = path.join(tmpDir, '.git');
        const stat = await fs.stat(gitDir);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        // Cleanup
        const fs = await import('node:fs/promises');
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should use custom default branch', async () => {
      const tmpDir = await import('node:fs/promises').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'makaio-test-')));

      try {
        const response = await bus.request(GitSubjects.initRepo, {
          path: tmpDir,
          defaultBranch: 'develop',
        });

        expect(response.success).toBe(true);
        expect(response.defaultBranch).toBe('develop');
      } finally {
        const fs = await import('node:fs/promises');
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('createWorktree', () => {
    it('should create a new worktree with new branch', async () => {
      const fs = await import('node:fs/promises');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-wt-test-'));
      const worktreePath = path.join(tmpDir, 'feature-worktree');

      try {
        // Initialize a repo with at least one commit
        await bus.request(GitSubjects.initRepo, { path: tmpDir });
        const git = (await import('simple-git')).simpleGit(tmpDir);
        await configureTestGit(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
        await git.add('.');
        await git.commit('Initial commit');

        // Create worktree with new branch
        const response = await bus.request(GitSubjects.createWorktree, {
          repoPath: tmpDir,
          path: worktreePath,
          branch: 'feature-test',
          createBranch: true,
        });

        expect(response.success).toBe(true);
        expect(response.path).toBe(worktreePath);
        expect(response.branch).toBe('feature-test');

        // Verify worktree was created
        const stat = await fs.stat(worktreePath);
        expect(stat.isDirectory()).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return error for invalid path', async () => {
      const fs = await import('node:fs/promises');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-wt-test-'));

      try {
        // Setup: create repo with commit
        await bus.request(GitSubjects.initRepo, { path: tmpDir });
        const git = (await import('simple-git')).simpleGit(tmpDir);
        await configureTestGit(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
        await git.add('.');
        await git.commit('Initial commit');

        // Use a path that requires creating directories under a regular file.
        // This is deterministic across platforms and avoids POSIX-only paths.
        const nonDirectoryPath = path.join(tmpDir, 'not-a-directory');
        await fs.writeFile(nonDirectoryPath, 'content');
        const invalidPath = path.join(nonDirectoryPath, 'child');
        const response = await bus.request(GitSubjects.createWorktree, {
          repoPath: tmpDir,
          path: invalidPath,
          branch: 'test-branch',
          createBranch: true,
        });

        expect(response.success).toBe(false);
        expect(response.error).toBeDefined();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('removeWorktree', () => {
    it('should remove an existing worktree', async () => {
      const fs = await import('node:fs/promises');
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-wt-test-'));
      const worktreePath = path.join(tmpDir, 'to-remove');

      try {
        // Setup: create repo with commit and worktree
        await bus.request(GitSubjects.initRepo, { path: tmpDir });
        const git = (await import('simple-git')).simpleGit(tmpDir);
        await configureTestGit(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
        await git.add('.');
        await git.commit('Initial commit');

        await bus.request(GitSubjects.createWorktree, {
          repoPath: tmpDir,
          path: worktreePath,
          branch: 'to-remove-branch',
          createBranch: true,
        });

        // Remove the worktree
        const response = await bus.request(GitSubjects.removeWorktree, {
          repoPath: tmpDir,
          path: worktreePath,
        });

        expect(response.success).toBe(true);

        // Verify worktree directory was removed
        await expect(fs.stat(worktreePath)).rejects.toThrow();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('should delete branch when deleteBranch is true', async () => {
      const fs = await import('node:fs/promises');
      // Use realpath to avoid macOS /var vs /private/var symlink issues
      const tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-wt-test-')));
      const worktreePath = path.join(tmpDir, 'to-remove');

      try {
        // Setup
        await bus.request(GitSubjects.initRepo, { path: tmpDir });
        const git = (await import('simple-git')).simpleGit(tmpDir);
        await configureTestGit(tmpDir);
        await fs.writeFile(path.join(tmpDir, 'README.md'), '# Test');
        await git.add('.');
        await git.commit('Initial commit');

        await bus.request(GitSubjects.createWorktree, {
          repoPath: tmpDir,
          path: worktreePath,
          branch: 'branch-to-delete',
          createBranch: true,
        });

        // Remove with deleteBranch
        const response = await bus.request(GitSubjects.removeWorktree, {
          repoPath: tmpDir,
          path: worktreePath,
          deleteBranch: true,
        });

        expect(response.success).toBe(true);

        // Verify branch was deleted
        const branches = await git.branchLocal();
        expect(branches.all).not.toContain('branch-to-delete');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('stage', () => {
    it('should stage a file', async () => {
      const { repoPath } = await createRepoWithInitialCommit();

      try {
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(repoPath, 'new-file.txt'), 'content'));

        const result = await bus.request(GitSubjects.stage, {
          repoPath,
          paths: ['new-file.txt'],
        });

        expect(result.success).toBe(true);

        const status = await bus.request(GitSubjects.getStatus, { repoPath });
        expect(status.staged).toContain('new-file.txt');
      } finally {
        await import('node:fs/promises').then((fs) => fs.rm(repoPath, { recursive: true, force: true }));
      }
    });

    it('should return error for non-existent file', async () => {
      const { repoPath } = await createRepoWithInitialCommit();

      try {
        const result = await bus.request(GitSubjects.stage, {
          repoPath,
          paths: ['does-not-exist.txt'],
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      } finally {
        await import('node:fs/promises').then((fs) => fs.rm(repoPath, { recursive: true, force: true }));
      }
    });

    it('should return error for empty path entries', async () => {
      const { repoPath } = await createRepoWithInitialCommit();

      try {
        const result = await bus.request(GitSubjects.stage, {
          repoPath,
          paths: [''],
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      } finally {
        await import('node:fs/promises').then((fs) => fs.rm(repoPath, { recursive: true, force: true }));
      }
    });
  });

  describe('unstage', () => {
    it('should unstage a file', async () => {
      const { repoPath, git } = await createRepoWithInitialCommit();

      try {
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(repoPath, 'new-file.txt'), 'content'));

        await git.add('new-file.txt');

        const result = await bus.request(GitSubjects.unstage, {
          repoPath,
          paths: ['new-file.txt'],
        });

        expect(result.success).toBe(true);

        const status = await bus.request(GitSubjects.getStatus, { repoPath });
        expect(status.staged).not.toContain('new-file.txt');
      } finally {
        await import('node:fs/promises').then((fs) => fs.rm(repoPath, { recursive: true, force: true }));
      }
    });

    it('should not unstage anything for empty path entries', async () => {
      const { repoPath, git } = await createRepoWithInitialCommit();

      try {
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(repoPath, 'new-file.txt'), 'content'));
        await git.add('new-file.txt');

        const result = await bus.request(GitSubjects.unstage, {
          repoPath,
          paths: [''],
        });

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();

        const status = await bus.request(GitSubjects.getStatus, { repoPath });
        expect(status.staged).toContain('new-file.txt');
      } finally {
        await import('node:fs/promises').then((fs) => fs.rm(repoPath, { recursive: true, force: true }));
      }
    });
  });

  describe('getBranchCommits', () => {
    it('should return all commit hashes reachable from a branch', async () => {
      const { repoPath, git } = await createRepoWithInitialCommit();

      try {
        // Create a second commit
        await import('node:fs/promises').then((fs) => fs.writeFile(path.join(repoPath, 'file2.txt'), 'content2'));
        await git.add('file2.txt');
        await git.commit('second commit');

        // Get current branch name
        const branchResult = await bus.request(GitSubjects.getBranch, { repoPath });

        const result = await bus.request(GitSubjects.getBranchCommits, {
          repoPath,
          branchName: branchResult.current,
        });

        expect(Array.isArray(result.commitHashes)).toBe(true);
        expect(result.commitHashes.length).toBe(2);
        // Verify they are full SHA hashes (40 characters)
        expect(result.commitHashes[0].length).toBe(40);
        expect(result.commitHashes[1].length).toBe(40);
      } finally {
        await import('node:fs/promises').then((fs) => fs.rm(repoPath, { recursive: true, force: true }));
      }
    });

    it('should return empty array for non-existent branch', async () => {
      const { repoPath } = await createRepoWithInitialCommit();

      try {
        const result = await bus.request(GitSubjects.getBranchCommits, {
          repoPath,
          branchName: 'non-existent-branch',
        });

        expect(Array.isArray(result.commitHashes)).toBe(true);
        expect(result.commitHashes.length).toBe(0);
      } finally {
        await import('node:fs/promises').then((fs) => fs.rm(repoPath, { recursive: true, force: true }));
      }
    });
  });
});

async function createRepoWithInitialCommit(): Promise<{ repoPath: string; git: import('simple-git').SimpleGit }> {
  const fs = await import('node:fs/promises');
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-git-test-'));
  await bus.request(GitSubjects.initRepo, { path: repoPath });
  const git = (await import('simple-git')).simpleGit(repoPath);
  await configureTestGit(repoPath);
  await fs.writeFile(path.join(repoPath, 'base.txt'), 'base\n');
  await git.add('base.txt');
  await git.commit('initial');
  return { repoPath, git };
}
