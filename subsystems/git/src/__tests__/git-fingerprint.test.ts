import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { computeFingerprint } from '../git-fingerprint.js';
import { createTestRepo, createTestRepoWithCommit, type TestRepo } from './git-test-utils.js';

const DEFAULT_INCLUDE = ['**/*'];
const DEFAULT_EXCLUDE: string[] = [];

describe('computeFingerprint', { timeout: 15_000 }, () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepoWithCommit('fingerprint-test-');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('produces a stable hash on repeated calls with no changes', async () => {
    const result1 = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);
    const result2 = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    expect(result1.hash).toBe(result2.hash);
    expect(result1.commitSha).toBe(result2.commitSha);
  });

  it('changes hash after a new commit', async () => {
    const before = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    await fs.writeFile(path.join(repo.repoPath, 'new-file.txt'), 'content\n');
    await repo.git.add('new-file.txt');
    await repo.git.commit('Add new file');

    const after = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    expect(after.hash).not.toBe(before.hash);
    expect(after.commitSha).not.toBe(before.commitSha);
  });

  it('changes hash when tracked files are modified (unstaged)', async () => {
    const before = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    await fs.writeFile(path.join(repo.repoPath, 'base.txt'), 'modified\n');

    const after = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    expect(after.hash).not.toBe(before.hash);
    // commit SHA should be the same (no new commit)
    expect(after.commitSha).toBe(before.commitSha);
    expect(after.changedPaths).toContain('base.txt');
  });

  it('changes hash when an untracked file is added', async () => {
    const before = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    await fs.writeFile(path.join(repo.repoPath, 'untracked.txt'), 'new\n');

    const after = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    expect(after.hash).not.toBe(before.hash);
    expect(after.changedPaths).toContain('untracked.txt');
  });

  it('respects include glob filtering', async () => {
    const includeTsOnly = ['**/*.ts'];
    const exclude: string[] = [];

    // Modify a non-TS file — should NOT affect the fingerprint
    await fs.writeFile(path.join(repo.repoPath, 'base.txt'), 'modified\n');

    const tsFingerprint = await computeFingerprint(repo.repoPath, includeTsOnly, exclude);

    // Add a .ts file — should affect the fingerprint
    await fs.writeFile(path.join(repo.repoPath, 'app.ts'), 'console.log("hi");\n');

    const tsFingerprint2 = await computeFingerprint(repo.repoPath, includeTsOnly, exclude);

    // Only the .ts addition should cause a change
    expect(tsFingerprint2.hash).not.toBe(tsFingerprint.hash);
    expect(tsFingerprint2.changedPaths).toContain('app.ts');
    // base.txt should NOT be in changedPaths (not matching include)
    expect(tsFingerprint2.changedPaths).not.toContain('base.txt');
  });

  it('respects exclude glob filtering', async () => {
    const exclude = ['**/*.txt'];

    const before = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, exclude);

    // Modify a .txt file — excluded, should NOT affect fingerprint
    await fs.writeFile(path.join(repo.repoPath, 'base.txt'), 'modified\n');

    const after = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, exclude);

    expect(after.hash).toBe(before.hash);
  });

  it('is deterministic regardless of glob array ordering', async () => {
    await fs.writeFile(path.join(repo.repoPath, 'a.ts'), 'a');
    await fs.writeFile(path.join(repo.repoPath, 'b.js'), 'b');

    const include1 = ['**/*.ts', '**/*.js'];
    const include2 = ['**/*.js', '**/*.ts'];

    const result1 = await computeFingerprint(repo.repoPath, include1, []);
    const result2 = await computeFingerprint(repo.repoPath, include2, []);

    expect(result1.hash).toBe(result2.hash);
  });

  it('returns valid response shape', async () => {
    const result = await computeFingerprint(repo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

    expect(result.hash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    expect(result.commitSha).toMatch(/^[a-f0-9]{40}$/); // git sha
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(Array.isArray(result.changedPaths)).toBe(true);
  });

  it('handles repos with no commits deterministically', async () => {
    const noCommitRepo = await createTestRepo('fingerprint-no-commit-');
    try {
      await fs.writeFile(path.join(noCommitRepo.repoPath, 'z.txt'), 'z\n');
      await fs.writeFile(path.join(noCommitRepo.repoPath, 'a.txt'), 'a\n');

      const result1 = await computeFingerprint(noCommitRepo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);
      const result2 = await computeFingerprint(noCommitRepo.repoPath, DEFAULT_INCLUDE, DEFAULT_EXCLUDE);

      expect(result1.hash).toBe(result2.hash);
      expect(result1.commitSha).toBe('0'.repeat(40));
      expect(result1.changedPaths).toEqual(['a.txt', 'z.txt']);
    } finally {
      await noCommitRepo.cleanup();
    }
  });

  it('treats empty include globs as match-all', async () => {
    await fs.writeFile(path.join(repo.repoPath, 'tracked-empty-include.txt'), 'v1\n');
    await repo.git.add('tracked-empty-include.txt');
    await repo.git.commit('Add tracked file');

    const before = await computeFingerprint(repo.repoPath, [], DEFAULT_EXCLUDE);
    await fs.writeFile(path.join(repo.repoPath, 'tracked-empty-include.txt'), 'v2\n');
    const after = await computeFingerprint(repo.repoPath, [], DEFAULT_EXCLUDE);

    expect(after.hash).not.toBe(before.hash);
    expect(after.changedPaths).toContain('tracked-empty-include.txt');
  });
});
