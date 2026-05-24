import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installGitHooks } from '../install/install.js';
import { readGitHookStatus } from '../install/status.js';
import { uninstallGitHooks } from '../install/uninstall.js';
import { resolveGitHookTargets } from '../install/hook-targets.js';
import {
  GIT_HOOK_NAMES,
  GitHookInstallStateSchema,
  STATE_FILE_NAME,
  type GitHookInstallState,
} from '../install/hook-state.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('git hook install state', () => {
  it('lists the supported native hook names', () => {
    expect(GIT_HOOK_NAMES).toEqual(['post-commit', 'post-checkout', 'post-merge', 'post-rewrite']);
  });

  it('parses an install state with per-hook hashes', () => {
    const parsed = GitHookInstallStateSchema.parse({
      version: 1,
      repoRoot: '/repo',
      hookDir: '/repo/.git/hooks',
      receiverCommand: ['/usr/local/bin/makaio-git-hook-receiver'],
      installedAt: '2026-05-24T00:00:00.000Z',
      hooks: {
        'post-commit': {
          hookName: 'post-commit',
          hookPath: '/repo/.git/hooks/post-commit',
          wrapperHash: 'abc',
          backupPath: '/repo/.git/hooks/post-commit.pre-makaio',
          backupHash: 'def',
          previousExists: true,
        },
      },
    });

    expect(parsed.hooks['post-commit']?.previousExists).toBe(true);
  });
});

describe('resolveGitHookTargets', { timeout: 30_000 }, () => {
  it('resolves hook paths through git plumbing for a normal repo', async () => {
    const repo = await makeTempDir('makaio-git-hooks-normal-');
    await execaGit(['init'], repo);

    const targets = await resolveGitHookTargets(repo);

    expect(targets.repoRoot).toBe(repo);
    expect(targets.isBare).toBe(false);
    expect(targets.hooks.map((hook) => hook.name)).toEqual(GIT_HOOK_NAMES);
    expect(targets.hooks[0]?.path).toContain(path.join('.git', 'hooks'));
  });
});

describe('installGitHooks', { timeout: 30_000 }, () => {
  it('installs executable wrappers and restores the original hook on uninstall', async () => {
    const repo = await makeTempDir('makaio-git-hooks-install-');
    await execaGit(['init'], repo);
    const hookDir = path.join(repo, '.git', 'hooks');
    const originalPath = path.join(hookDir, 'post-commit');
    await fs.writeFile(originalPath, '#!/bin/sh\nexit 7\n', { mode: 0o755 });

    await installGitHooks({
      repoPath: repo,
      receiverCommand: ['/bin/echo'],
    });

    const status = await readGitHookStatus(repo);
    expect(status.coveredOperations).toContain('commit');

    const wrapper = await fs.readFile(originalPath, 'utf8');
    expect(wrapper).toContain('makaio git-hooks wrapper');
    expect(wrapper).toContain('mktemp');
    expect((await fs.stat(originalPath)).mode & 0o111).not.toBe(0);

    await uninstallGitHooks({ repoPath: repo });
    expect(await fs.readFile(originalPath, 'utf8')).toBe('#!/bin/sh\nexit 7\n');
  });

  it('rejects receiver commands that are not absolute executable files', async () => {
    const bareCommandRepo = await makeTempDir('makaio-git-hooks-bare-receiver-');
    await execaGit(['init'], bareCommandRepo);

    await expect(
      installGitHooks({
        repoPath: bareCommandRepo,
        receiverCommand: ['makaio-git-hook-receiver'],
      }),
    ).rejects.toThrow(/absolute executable/);
    expect(await fileExists(statePath(bareCommandRepo))).toBe(false);

    const nonExecutableRepo = await makeTempDir('makaio-git-hooks-nonexec-receiver-');
    await execaGit(['init'], nonExecutableRepo);
    const nonExecutable = path.join(nonExecutableRepo, 'receiver');
    await fs.writeFile(nonExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o644 });

    await expect(
      installGitHooks({
        repoPath: nonExecutableRepo,
        receiverCommand: [nonExecutable],
      }),
    ).rejects.toThrow(/absolute executable/);
    expect(await fileExists(statePath(nonExecutableRepo))).toBe(false);
  });

  it('does not report coverage from state copied from another repository', async () => {
    const sourceRepo = await makeTempDir('makaio-git-hooks-source-');
    const targetRepo = await makeTempDir('makaio-git-hooks-target-');
    await execaGit(['init'], sourceRepo);
    await execaGit(['init'], targetRepo);

    await installGitHooks({
      repoPath: sourceRepo,
      receiverCommand: ['/bin/echo'],
    });
    await fs.copyFile(statePath(sourceRepo), statePath(targetRepo));

    const status = await readGitHookStatus(targetRepo);

    expect(status.covered).toBe(false);
    expect(status.reason).toBe('state-mismatch');
    expect(status.coveredOperations).toEqual([]);
  });

  it('does not report coverage after core.hooksPath moves away from installed wrappers', async () => {
    const repo = await makeTempDir('makaio-git-hooks-hookspath-');
    await execaGit(['init'], repo);
    await installGitHooks({
      repoPath: repo,
      receiverCommand: ['/bin/echo'],
    });

    await fs.mkdir(path.join(repo, '.githooks'));
    await execaGit(['config', 'core.hooksPath', '.githooks'], repo);

    const status = await readGitHookStatus(repo);

    expect(status.covered).toBe(false);
    expect(status.coveredOperations).toEqual([]);
  });

  it('refuses to reinstall over a managed wrapper when state is missing', async () => {
    const repo = await makeTempDir('makaio-git-hooks-missing-state-');
    await execaGit(['init'], repo);
    const originalPath = path.join(repo, '.git', 'hooks', 'post-commit');
    await fs.writeFile(originalPath, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    await installGitHooks({
      repoPath: repo,
      receiverCommand: ['/bin/echo'],
    });
    const wrapperBefore = await fs.readFile(originalPath, 'utf8');
    const backupPath = `${originalPath}.pre-makaio`;
    const backupBefore = await fs.readFile(backupPath, 'utf8');
    await fs.unlink(statePath(repo));

    await expect(
      installGitHooks({
        repoPath: repo,
        receiverCommand: ['/bin/echo'],
      }),
    ).rejects.toThrow(/state/i);

    expect(await fs.readFile(originalPath, 'utf8')).toBe(wrapperBefore);
    expect(await fs.readFile(backupPath, 'utf8')).toBe(backupBefore);
  });

  it('uses exclusive temporary wrapper paths that do not follow predictable symlinks', async () => {
    const repo = await makeTempDir('makaio-git-hooks-temp-symlink-');
    await execaGit(['init'], repo);
    const hookDir = path.join(repo, '.git', 'hooks');
    const victimPath = path.join(repo, 'victim.txt');
    const fixedTempPath = path.join(hookDir, 'post-commit.makaio-tmp');
    await fs.writeFile(victimPath, 'do not overwrite\n');
    await fs.symlink(victimPath, fixedTempPath);

    await installGitHooks({
      repoPath: repo,
      receiverCommand: ['/bin/echo'],
    });

    expect(await fs.readFile(victimPath, 'utf8')).toBe('do not overwrite\n');
    expect((await fs.lstat(path.join(hookDir, 'post-commit'))).isSymbolicLink()).toBe(false);
  });
});

describe('uninstallGitHooks', { timeout: 30_000 }, () => {
  it('refuses outside hook paths without unlinking them', async () => {
    const repo = await makeTempDir('makaio-git-hooks-outside-uninstall-');
    await execaGit(['init'], repo);
    await installGitHooks({
      repoPath: repo,
      receiverCommand: ['/bin/echo'],
    });
    const state = await readState(repo);
    const postCommit = state.hooks['post-commit'];
    expect(postCommit).toBeDefined();
    const outsidePath = path.join(repo, '..', `${path.basename(repo)}-outside-hook`);
    await fs.copyFile(postCommit!.hookPath, outsidePath);
    await writeState(repo, {
      ...state,
      hooks: {
        ...state.hooks,
        'post-commit': {
          ...postCommit!,
          hookPath: outsidePath,
        },
      },
    });

    await expect(uninstallGitHooks({ repoPath: repo })).rejects.toThrow(/State entry for post-commit/i);

    expect(await fileExists(outsidePath)).toBe(true);
    expect(await fileExists(path.join(repo, '.git', 'hooks', 'post-commit'))).toBe(true);
    await fs.rm(outsidePath, { force: true });
  });

  it('preflights all wrappers before removing any hook', async () => {
    const repo = await makeTempDir('makaio-git-hooks-preflight-wrapper-');
    await execaGit(['init'], repo);
    const postCommit = path.join(repo, '.git', 'hooks', 'post-commit');
    const postCheckout = path.join(repo, '.git', 'hooks', 'post-checkout');
    await fs.writeFile(postCommit, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    await fs.writeFile(postCheckout, '#!/bin/sh\nexit 8\n', { mode: 0o755 });
    await installGitHooks({
      repoPath: repo,
      receiverCommand: ['/bin/echo'],
    });
    const postCommitWrapper = await fs.readFile(postCommit, 'utf8');
    const postCheckoutWrapper = await fs.readFile(postCheckout, 'utf8');
    await fs.appendFile(postCheckout, '\n# edited\n');

    await expect(uninstallGitHooks({ repoPath: repo })).rejects.toThrow(/modified wrapper/i);

    expect(await fs.readFile(postCommit, 'utf8')).toBe(postCommitWrapper);
    expect(await fs.readFile(postCheckout, 'utf8')).toBe(`${postCheckoutWrapper}\n# edited\n`);
    expect(await fs.readFile(`${postCommit}.pre-makaio`, 'utf8')).toBe('#!/bin/sh\nexit 7\n');
  });

  it('preserves wrappers and backups when a backup was modified', async () => {
    const repo = await makeTempDir('makaio-git-hooks-preflight-backup-');
    await execaGit(['init'], repo);
    const hookPath = path.join(repo, '.git', 'hooks', 'post-commit');
    const backupPath = `${hookPath}.pre-makaio`;
    await fs.writeFile(hookPath, '#!/bin/sh\nexit 7\n', { mode: 0o755 });
    await installGitHooks({
      repoPath: repo,
      receiverCommand: ['/bin/echo'],
    });
    const wrapper = await fs.readFile(hookPath, 'utf8');
    await fs.writeFile(backupPath, '#!/bin/sh\nexit 9\n', { mode: 0o755 });

    await expect(uninstallGitHooks({ repoPath: repo })).rejects.toThrow(/modified backup/i);

    expect(await fs.readFile(hookPath, 'utf8')).toBe(wrapper);
    expect(await fs.readFile(backupPath, 'utf8')).toBe('#!/bin/sh\nexit 9\n');
    expect(await fileExists(statePath(repo))).toBe(true);
  });
});

async function execaGit(args: string[], cwd: string): Promise<void> {
  const { execa } = await import('execa');
  await execa('git', args, { cwd });
}

function statePath(repo: string): string {
  return path.join(repo, '.git', 'hooks', STATE_FILE_NAME);
}

async function readState(repo: string): Promise<GitHookInstallState> {
  return GitHookInstallStateSchema.parse(JSON.parse(await fs.readFile(statePath(repo), 'utf8')));
}

async function writeState(repo: string, state: GitHookInstallState): Promise<void> {
  await fs.writeFile(statePath(repo), JSON.stringify(state, null, 2));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
