import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type SimpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWorkingTreeDetails } from '../queries/working-tree.js';
import { type TestRepo, createTestRepo } from './git-test-utils.js';

describe('getWorkingTreeDetails', { timeout: 20_000 }, () => {
  let repoPath: string;
  let git: SimpleGit;
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await createTestRepo('git-working-tree-');
    repoPath = repo.repoPath;
    git = repo.git;

    await fs.writeFile(path.join(repoPath, 'a.txt'), 'one\n');
    await git.add('a.txt');
    await git.commit('Initial commit');
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('tracks staged rename stats using the new path', async () => {
    await git.mv('a.txt', 'b.txt');
    await fs.writeFile(path.join(repoPath, 'b.txt'), 'one\ntwo\n');
    await git.add('b.txt');

    const details = await getWorkingTreeDetails(git);
    const entry = details.staged.find((item) => item.path === 'b.txt');
    const oldEntry = details.staged.find((item) => item.path === 'a.txt');

    expect(entry).toBeDefined();
    expect(oldEntry).toBeUndefined();
    expect(entry?.oldPath).toBe('a.txt');
    expect(entry?.additions).toBe(1);
    expect(entry?.deletions).toBe(0);
    expect(details.stats.changedFiles).toBeGreaterThan(0);
  });

  it('keeps rename mapping correct when a non-rename path starts with R', async () => {
    await fs.writeFile(path.join(repoPath, 'README.md'), 'docs\n');
    await git.add('README.md');
    await git.commit('Add README');

    await git.mv('a.txt', 'b.txt');
    await fs.writeFile(path.join(repoPath, 'b.txt'), 'one\ntwo\n');
    await fs.writeFile(path.join(repoPath, 'README.md'), 'docs\nupdated\n');
    await git.add('b.txt');
    await git.add('README.md');

    const details = await getWorkingTreeDetails(git);
    const renamed = details.staged.find((item) => item.path === 'b.txt');

    expect(renamed).toBeDefined();
    expect(renamed?.oldPath).toBe('a.txt');
    expect(renamed?.additions).toBe(1);
    expect(renamed?.deletions).toBe(0);
  });
});
