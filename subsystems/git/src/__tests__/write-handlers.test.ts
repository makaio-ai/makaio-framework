import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { GitSubjects } from '../namespace.js';
import { registerWriteHandlers } from '../write-handlers.js';
import { createTestRepoWithCommit, type TestRepo } from './git-test-utils.js';

describe('registerWriteHandlers', { timeout: 20_000 }, () => {
  let bus: IMakaioBus;
  let repo: TestRepo;
  let cleanups: Array<() => void>;

  beforeEach(async () => {
    bus = createBusInstance();
    cleanups = registerWriteHandlers(bus);
    repo = await createTestRepoWithCommit('git-write-handlers-');
  });

  afterEach(async () => {
    cleanups.forEach((cleanup) => cleanup());
    await repo.cleanup();
  });

  it('should forward startPoint when checkout creates a new branch', async () => {
    await repo.git.raw(['checkout', '-b', 'source']);
    await fs.writeFile(path.join(repo.repoPath, 'source-only.txt'), 'from source');
    await repo.git.add('source-only.txt');
    await repo.git.commit('source commit');
    const sourceHead = (await repo.git.revparse(['HEAD'])).trim();
    await repo.git.checkout('main');

    const result = await bus.request(GitSubjects.checkoutRef, {
      repoPath: repo.repoPath,
      ref: 'from-source',
      createBranch: true,
      startPoint: 'source',
    });

    expect(result.success).toBe(true);
    expect(result.ref).toBe('from-source');

    const currentHead = (await repo.git.revparse(['HEAD'])).trim();
    expect(currentHead).toBe(sourceHead);
  });

  it('should always return a result for schema-valid stash operations', async () => {
    const result = await bus.request(GitSubjects.stash, {
      repoPath: repo.repoPath,
      operation: 'list',
    });

    expect(result.success).toBe(true);
    expect(Array.isArray(result.entries)).toBe(true);
  });

  it('should allow fast-forward when merge approach is omitted', async () => {
    await repo.git.raw(['checkout', '-b', 'feature']);
    await fs.writeFile(path.join(repo.repoPath, 'ff.txt'), 'ff');
    await repo.git.add('ff.txt');
    await repo.git.commit('feature commit');
    await repo.git.checkout('main');

    const result = await bus.request(GitSubjects.mergeBranch, {
      repoPath: repo.repoPath,
      source: 'feature',
    });

    expect(result.success).toBe(true);
    expect(result.fastForward).toBe(true);
    expect(result.hash).toBeUndefined();
  });

  it('should abort an in-progress merge', async () => {
    await repo.git.raw(['checkout', '-b', 'feature-conflict']);
    await fs.writeFile(path.join(repo.repoPath, 'shared.txt'), 'feature version\n');
    await repo.git.add('shared.txt');
    await repo.git.commit('feature change');
    await repo.git.checkout('main');
    await fs.writeFile(path.join(repo.repoPath, 'shared.txt'), 'main version\n');
    await repo.git.add('shared.txt');
    await repo.git.commit('main change');

    const mergeResult = await bus.request(GitSubjects.mergeBranch, {
      repoPath: repo.repoPath,
      source: 'feature-conflict',
    });
    expect(mergeResult.success).toBe(false);
    expect(mergeResult.conflicts?.length).toBeGreaterThan(0);

    const abortResult = await bus.request(GitSubjects.mergeAbort, {
      repoPath: repo.repoPath,
    });
    expect(abortResult.success).toBe(true);

    const status = await repo.git.status();
    expect(status.conflicted).toHaveLength(0);
  });
});
