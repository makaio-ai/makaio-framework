import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { GitBlameResponse } from '../schemas.js';
import { getBlame } from '../queries/blame.js';
import { createTestRepoWithCommit, type TestRepo } from './git-test-utils.js';

const BLAME_FILE = 'src/index.ts';
const GIT_FIXTURE_HOOK_TIMEOUT_MS = 60_000;

/**
 * Write content to the blame fixture file and commit it with deterministic author metadata.
 *
 * Uses `--author` instead of reconfiguring git identity to avoid extra subprocess spawns.
 * @param repo - Test repository
 * @param content - File content to write
 * @param message - Commit message
 * @param authorName - Commit author name
 * @param authorEmail - Commit author email
 * @returns Created commit hash
 */
async function commitFile(
  repo: TestRepo,
  content: string,
  message: string,
  authorName: string,
  authorEmail: string,
): Promise<string> {
  const absolutePath = path.join(repo.repoPath, BLAME_FILE);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content);
  await repo.git.add(BLAME_FILE);
  await repo.git.commit(message, { '--author': `${authorName} <${authorEmail}>` });
  return (await repo.git.revparse(['HEAD'])).trim();
}

describe('getBlame', { timeout: 20_000 }, () => {
  describe('single commit, all lines', () => {
    let repo: TestRepo;
    let result: GitBlameResponse;
    let commitHash: string;

    beforeAll(async () => {
      repo = await createTestRepoWithCommit('git-blame-');
      commitHash = await commitFile(
        repo,
        'const x = 1;\nconst y = 2;\nexport { x, y };',
        'Initial commit',
        'Alice',
        'alice@example.com',
      );
      result = await getBlame(repo.git, BLAME_FILE);
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await repo.cleanup();
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    it('should return file content from git show', () => {
      expect(result.content).toBe('const x = 1;\nconst y = 2;\nexport { x, y };');
    });

    it('should collapse consecutive lines from the same commit', () => {
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toMatchObject({
        startLine: 1,
        endLine: 3,
        hash: commitHash,
        shortHash: commitHash.slice(0, 7),
        author: 'Alice',
        message: 'Initial commit',
      });
      expect(new Date(result.lines[0].date).toISOString()).toBe(result.lines[0].date);
    });
  });

  describe('two commits, contiguous ranges', () => {
    let repo: TestRepo;
    let result: GitBlameResponse;

    beforeAll(async () => {
      repo = await createTestRepoWithCommit('git-blame-');
      await commitFile(repo, 'line 1\nline 2\nline 3\nline 4', 'First feature', 'Alice', 'alice@example.com');
      await commitFile(
        repo,
        'line 1\nline 2\nline 3 changed\nline 4 changed',
        'Second feature',
        'Bob',
        'bob@example.com',
      );
      result = await getBlame(repo.git, BLAME_FILE);
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await repo.cleanup();
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    it('should produce two blame ranges', () => {
      expect(result.lines).toHaveLength(2);
    });

    it('should have correct range for first commit', () => {
      expect(result.lines[0]).toMatchObject({
        startLine: 1,
        endLine: 2,
        author: 'Alice',
        message: 'First feature',
      });
    });

    it('should have correct range for second commit', () => {
      expect(result.lines[1]).toMatchObject({
        startLine: 3,
        endLine: 4,
        author: 'Bob',
        message: 'Second feature',
      });
    });
  });

  describe('interleaved commits', () => {
    let repo: TestRepo;
    let result: GitBlameResponse;

    beforeAll(async () => {
      repo = await createTestRepoWithCommit('git-blame-');
      await commitFile(repo, 'line 1\nline 2\nline 3', 'First', 'Alice', 'alice@example.com');
      await commitFile(repo, 'line 1\nline 2 changed\nline 3', 'Second', 'Bob', 'bob@example.com');
      result = await getBlame(repo.git, BLAME_FILE);
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await repo.cleanup();
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    it('should produce three ranges for A-B-A pattern', () => {
      // A(1), B(2), A(3) - cannot collapse because B interrupts
      expect(result.lines).toHaveLength(3);
    });

    it('should have Alice for first and third ranges', () => {
      expect(result.lines[0].author).toBe('Alice');
      expect(result.lines[1].author).toBe('Bob');
      expect(result.lines[2].author).toBe('Alice');
    });

    it('should have single-line ranges for each', () => {
      expect(result.lines[0]).toMatchObject({
        startLine: 1,
        endLine: 1,
      });
      expect(result.lines[1]).toMatchObject({
        startLine: 2,
        endLine: 2,
      });
      expect(result.lines[2]).toMatchObject({
        startLine: 3,
        endLine: 3,
      });
    });
  });

  describe('empty file', () => {
    let repo: TestRepo;
    let result: GitBlameResponse;

    beforeAll(async () => {
      repo = await createTestRepoWithCommit('git-blame-');
      await commitFile(repo, '', 'empty file', 'Alice', 'alice@example.com');
      result = await getBlame(repo.git, BLAME_FILE);
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await repo.cleanup();
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    it('should return empty lines for empty porcelain output', () => {
      expect(result.lines).toEqual([]);
      expect(result.content).toBe('');
    });
  });

  describe('ref parameter', () => {
    let repo: TestRepo;
    let result: GitBlameResponse;
    let initialRef: string;

    beforeAll(async () => {
      repo = await createTestRepoWithCommit('git-blame-');
      initialRef = await commitFile(repo, 'line 1\nline 2\n', 'baseline', 'Alice', 'alice@example.com');
      await commitFile(repo, 'line 1 changed\nline 2 changed\n', 'follow-up', 'Bob', 'bob@example.com');
      result = await getBlame(repo.git, BLAME_FILE, initialRef);
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await repo.cleanup();
    }, GIT_FIXTURE_HOOK_TIMEOUT_MS);

    it('should honor ref and return historical blame/content', () => {
      expect(result.content).toBe('line 1\nline 2\n');
      expect(result.lines).toHaveLength(1);
      expect(result.lines[0]).toMatchObject({
        startLine: 1,
        endLine: 2,
        hash: initialRef,
        author: 'Alice',
        message: 'baseline',
      });
    });
  });
});
