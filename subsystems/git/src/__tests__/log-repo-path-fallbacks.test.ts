import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fallback path tests using mocked git.
 *
 * These tests exercise version-specific fallback logic in `resolveRepositoryIdentity`
 * that progressively tries `--path-format=absolute`, `--git-common-dir`, and
 * `--absolute-git-dir`. Real git only exercises whichever flag the installed
 * version supports first, so mocking is required to cover the fallback branches.
 */

const simpleGitMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn(async (targetPath: string) => targetPath));

vi.mock('simple-git', () => ({
  simpleGit: simpleGitMock,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    realpath: realpathMock,
  };
});

import { resolveLogRepoPath } from '../log-repo-path.js';

/**
 * Create a mock revparse that throws for unsupported flags and returns configured values.
 * @param config - Map of revparse flag to result (or undefined to throw)
 * @returns A vi.fn mock implementing the revparse interface
 */
function createRevparseMock(config: Record<string, string | ((repoPath: string) => string)>): ReturnType<typeof vi.fn> {
  return vi.fn(async (args: string[]) => {
    const flag = args[0];
    const handler = config[flag];
    if (handler === undefined) {
      throw new Error(`unsupported option: ${flag}`);
    }
    return typeof handler === 'function' ? handler : handler;
  });
}

describe('resolveLogRepoPath (version fallback paths)', () => {
  beforeEach(() => {
    simpleGitMock.mockReset();
    realpathMock.mockReset();
    realpathMock.mockImplementation(async (targetPath: string) => targetPath);
  });

  it('accepts same repository when --path-format fallback to --git-common-dir succeeds', async () => {
    simpleGitMock.mockImplementation((repoPath: string) => ({
      revparse: createRevparseMock({
        '--git-common-dir': repoPath === '/repo' ? '.git' : '../.git',
      }),
    }));

    const result = await resolveLogRepoPath('/repo', '/repo/wt');
    expect(result).toBe('/repo/wt');
  });

  it('accepts same repository when falling back to --absolute-git-dir', async () => {
    simpleGitMock.mockImplementation((repoPath: string) => ({
      revparse: createRevparseMock({
        '--absolute-git-dir': repoPath === '/repo' ? '/repo/.git' : '/repo/.git/worktrees/wt',
      }),
    }));

    const result = await resolveLogRepoPath('/repo', '/repo/wt');
    expect(result).toBe('/repo/wt');
  });

  it('uses the git-internal worktrees segment when parent path also contains worktrees', async () => {
    simpleGitMock.mockImplementation((repoPath: string) => ({
      revparse: createRevparseMock({
        '--absolute-git-dir':
          repoPath === '/my/worktrees/project'
            ? '/my/worktrees/project/.git'
            : '/my/worktrees/project/.git/worktrees/wt',
      }),
    }));

    const result = await resolveLogRepoPath('/my/worktrees/project', '/my/worktrees/project/wt');
    expect(result).toBe('/my/worktrees/project/wt');
  });
});
