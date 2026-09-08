import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceRequirement } from '@makaio/contracts';
import { createLocalGitSourceRealizer } from '../git-source.js';
import { bindLocalWorkspace } from '../workspace-preparation.js';
import { createGitFixture } from '../../__tests__/git-test-fixtures.js';

let temporaryRoot: string;
let repository: string;
let workspaceRoot: string;
let firstRevision: string;

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-git-source-'));
  workspaceRoot = path.join(temporaryRoot, 'workspace');
  ({ repository, revision: firstRevision } = await createGitFixture(temporaryRoot));
});

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

/**
 * Declare source identity independently of its host-local repository locator.
 * @param revision - Revision selected by the execution owner.
 * @returns Frozen source-bearing workspace requirement.
 */
function requirement(revision = firstRevision): WorkspaceRequirement {
  return {
    provisioning: 'create',
    custody: 'disposable',
    setup: [],
    sourceRoots: [
      {
        id: 'primary',
        path: 'sources/project',
        source: {
          kind: 'git',
          input: { repositoryId: 'project', revision },
        },
      },
    ],
  };
}

/**
 * Assert bounded acquisition metadata without requiring byte-identical Git directories.
 * @param root - Realized Git source root.
 * @param sourcePath - Private source locator that acquisition must not write into its metadata.
 */
async function expectBoundedGitMetadata(root: string, sourcePath: string): Promise<void> {
  expect(execFileSync('git', ['for-each-ref', '--format=%(refname)'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
  expect(execFileSync('git', ['remote'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
  await expect(fs.stat(path.join(root, '.git/FETCH_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await fs.readFile(path.join(root, '.git/config'), 'utf8')).not.toContain(sourcePath);
  expect(await fs.readFile(path.join(root, '.git/logs/HEAD'), 'utf8')).not.toContain(sourcePath);
}

describe('local Git source realization', () => {
  it('accepts the timer maximum and rejects overflow before resolving a source', () => {
    const resolveRepository = async () => repository;
    expect(() => createLocalGitSourceRealizer({ timeoutMs: 2_147_483_647, resolveRepository })).not.toThrow();
    expect(() => createLocalGitSourceRealizer({ timeoutMs: 2_147_483_648, resolveRepository })).toThrow('2147483647');
  });

  it('refuses installation on Windows before repository access or Git execution', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const resolveRepository = vi.fn(async () => repository);
    try {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
      expect(() => createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository })).toThrow(
        'Local Git source preparation requires a POSIX host',
      );
      expect(resolveRepository).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('selects the requested commit in one contained source root and releases only its workspace', async () => {
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement(),
      realizeSource: createLocalGitSourceRealizer({
        timeoutMs: 5_000,
        resolveRepository: async (id) => {
          expect(id).toBe('project');
          return repository;
        },
      }),
    });
    const root = path.join(await fs.realpath(workspaceRoot), 'sources/project');
    expect(handle.binding.sourceRoots).toEqual([{ id: 'primary', path: root }]);
    expect(await fs.readFile(path.join(root, 'content.txt'), 'utf8')).toBe('selected revision');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(firstRevision);
    await expectBoundedGitMetadata(root, await fs.realpath(repository));
    const retainedSource = path.join(temporaryRoot, 'retained-source');
    await fs.rename(repository, retainedSource);
    expect(execFileSync('git', ['show', `${firstRevision}:content.txt`], { cwd: root, encoding: 'utf8' })).toBe(
      'selected revision',
    );
    await handle.release();
    await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(path.join(retainedSource, 'content.txt'), 'utf8')).toBe('later revision');
  });

  it('fetches the same complete selected ancestry despite moving unrelated source refs', async () => {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const realizeSource = createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => repository });
    const first = await bindLocalWorkspace({ workspaceRoot, requirement: requirement(revision), realizeSource });
    execFileSync('git', ['branch', 'unrelated', firstRevision], { cwd: repository });
    execFileSync('git', ['tag', 'unrelated-tag', firstRevision], { cwd: repository });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/unrelated'], { cwd: repository });
    const second = await bindLocalWorkspace({
      workspaceRoot: path.join(temporaryRoot, 'workspace-after-ref-change'),
      requirement: requirement(revision),
      realizeSource,
    });
    for (const handle of [first, second]) {
      const root = handle.binding.sourceRoots[0]!.path;
      await expectBoundedGitMetadata(root, await fs.realpath(repository));
      expect(execFileSync('git', ['rev-list', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n')).toEqual([
        revision,
        firstRevision,
      ]);
      expect(await fs.readFile(path.join(root, 'content.txt'), 'utf8')).toBe('later revision');
      await expect(fs.stat(path.join(root, '.git/shallow'))).rejects.toMatchObject({ code: 'ENOENT' });
      await handle.release();
    }
  });

  it('initializes the matching repository format for a SHA-256 source', async (context) => {
    const parent = path.join(temporaryRoot, 'sha256');
    await fs.mkdir(parent);
    const probe = spawnSync('git', ['init', '--quiet', '--object-format=sha256', path.join(parent, 'probe')], {
      encoding: 'utf8',
    });
    if (probe.status !== 0 && /unknown (hash algorithm|option)/i.test(probe.stderr)) context.skip();
    expect(probe.status).toBe(0);
    const source = await createGitFixture(parent, 'sha256');
    expect(source.revision).toHaveLength(64);
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement(source.revision),
      realizeSource: createLocalGitSourceRealizer({
        timeoutMs: 5_000,
        resolveRepository: async () => source.repository,
      }),
    });
    const root = handle.binding.sourceRoots[0]!.path;
    expect(execFileSync('git', ['rev-parse', '--show-object-format'], { cwd: root, encoding: 'utf8' }).trim()).toBe(
      'sha256',
    );
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(source.revision);
    expect(await fs.readFile(path.join(root, 'content.txt'), 'utf8')).toBe('selected revision');
    await expectBoundedGitMetadata(root, await fs.realpath(source.repository));
    await handle.release();
  });

  it('preserves a supplied shallow boundary and remains valid after the source is moved', async () => {
    const shallowSource = path.join(temporaryRoot, 'shallow-source');
    execFileSync('git', ['clone', '--quiet', '--no-local', '--depth=1', '--', repository, shallowSource]);
    const sourcePath = await fs.realpath(shallowSource);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: shallowSource, encoding: 'utf8' }).trim();
    expect(await fs.readFile(path.join(shallowSource, '.git/shallow'), 'utf8')).toBe(`${revision}\n`);
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement(revision),
      realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => shallowSource }),
    });
    await fs.rename(shallowSource, path.join(temporaryRoot, 'retained-shallow-source'));
    await fs.rename(repository, path.join(temporaryRoot, 'retained-full-source'));
    const root = handle.binding.sourceRoots[0]!.path;
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(revision);
    expect(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: root }).status).toBe(1);
    expect(execFileSync('git', ['rev-list', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(revision);
    expect(spawnSync('git', ['fsck', '--full'], { cwd: root }).status).toBe(0);
    expect(await fs.readFile(path.join(root, '.git/shallow'), 'utf8')).toBe(`${revision}\n`);
    expect(await fs.readFile(path.join(root, 'content.txt'), 'utf8')).toBe('later revision');
    await expectBoundedGitMetadata(root, sourcePath);
    await handle.release();
    await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('acquires through Git transport when the source uses a linked object directory', async () => {
    const objects = path.join(repository, '.git/objects');
    const backing = path.join(temporaryRoot, 'linked-objects');
    await fs.rename(objects, backing);
    await fs.symlink(backing, objects);
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement(),
      realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => repository }),
    });
    await fs.rename(backing, path.join(temporaryRoot, 'retained-objects'));
    expect(
      execFileSync('git', ['show', `${firstRevision}:content.txt`], {
        cwd: handle.binding.sourceRoots[0]!.path,
        encoding: 'utf8',
      }),
    ).toBe('selected revision');
    await handle.release();
  });

  it.each(['home', 'xdg'] as const)('ignores %s Git hooks and checkout transformations', async (location) => {
    await fs.writeFile(path.join(repository, 'lines.txt'), 'first\nsecond\n');
    execFileSync('git', ['add', 'lines.txt'], { cwd: repository });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'lines',
      ],
      { cwd: repository },
    );
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const isolatedHome = path.join(temporaryRoot, 'isolated-home');
    const xdg = path.join(temporaryRoot, 'xdg');
    const hooks = path.join(temporaryRoot, 'hooks');
    await Promise.all([fs.mkdir(isolatedHome), fs.mkdir(path.join(xdg, 'git'), { recursive: true }), fs.mkdir(hooks)]);
    const marker = path.join(temporaryRoot, 'hook-ran');
    await fs.writeFile(path.join(hooks, 'post-checkout'), `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o755 });
    const config = location === 'home' ? path.join(isolatedHome, '.gitconfig') : path.join(xdg, 'git/config');
    await fs.writeFile(config, `[core]\n  autocrlf = true\n  hooksPath = "${hooks}"\n`);
    vi.stubEnv('HOME', isolatedHome);
    vi.stubEnv('XDG_CONFIG_HOME', xdg);
    try {
      const handle = await bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(revision),
        realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => repository }),
      });
      expect(await fs.readFile(path.join(handle.binding.sourceRoots[0]!.path, 'lines.txt'), 'utf8')).toBe(
        'first\nsecond\n',
      );
      await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await handle.release();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'home',
    'xdg',
  ] as const)('ignores %s attributes but applies tracked project attributes', async (location) => {
    await fs.writeFile(path.join(repository, 'plain.txt'), 'first\nsecond\n');
    await fs.writeFile(path.join(repository, 'project.txt'), 'first\nsecond\n');
    await fs.writeFile(path.join(repository, '.gitattributes'), 'project.txt text eol=crlf\n');
    execFileSync('git', ['-c', `core.attributesFile=${os.devNull}`, 'add', '.'], { cwd: repository });
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'attributes',
      ],
      { cwd: repository },
    );
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const isolatedHome = path.join(temporaryRoot, 'isolated-home');
    const xdg = location === 'home' ? path.join(isolatedHome, '.config') : path.join(temporaryRoot, 'xdg');
    await fs.mkdir(path.join(xdg, 'git'), { recursive: true });
    await fs.mkdir(isolatedHome, { recursive: true });
    await fs.writeFile(path.join(xdg, 'git/attributes'), '* text eol=crlf\n');
    vi.stubEnv('HOME', isolatedHome);
    vi.stubEnv('XDG_CONFIG_HOME', location === 'home' ? undefined : xdg);
    try {
      const handle = await bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(revision),
        realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => repository }),
      });
      const root = handle.binding.sourceRoots[0]!.path;
      expect(await fs.readFile(path.join(root, 'plain.txt'), 'utf8')).toBe('first\nsecond\n');
      expect(await fs.readFile(path.join(root, 'project.txt'), 'utf8')).toBe('first\r\nsecond\r\n');
      expect(await fs.readFile(path.join(root, '.git/config'), 'utf8')).not.toContain('attributesFile');
      await handle.release();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('remains usable after a shared source loses access to its backing object store', async () => {
    const sharedSource = path.join(temporaryRoot, 'shared-source');
    execFileSync('git', ['clone', '--quiet', '--shared', '--', repository, sharedSource]);
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement(),
      realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => sharedSource }),
    });
    await fs.rename(repository, path.join(temporaryRoot, 'retained-backing-store'));
    const root = handle.binding.sourceRoots[0]!.path;
    expect(execFileSync('git', ['show', `${firstRevision}:content.txt`], { cwd: root, encoding: 'utf8' })).toBe(
      'selected revision',
    );
    await expect(fs.stat(path.join(root, '.git/objects/info/alternates'))).rejects.toMatchObject({ code: 'ENOENT' });
    await handle.release();
    await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    'GIT_INDEX_FILE',
    'GIT_DIR',
    'GIT_WORK_TREE',
  ])('ignores inherited %s without changing files or Git state outside its source root', async (variable) => {
    const outside = path.join(temporaryRoot, 'outside');
    await fs.mkdir(outside);
    const originalIndex = await fs.readFile(path.join(repository, '.git/index'));
    const originalHead = await fs.readFile(path.join(repository, '.git/HEAD'));
    await fs.writeFile(path.join(outside, 'index'), originalIndex);
    await fs.writeFile(path.join(outside, 'sentinel'), 'keep');
    const values: Record<string, string> = {
      GIT_INDEX_FILE: path.join(outside, 'index'),
      GIT_DIR: path.join(repository, '.git'),
      GIT_WORK_TREE: outside,
    };
    vi.stubEnv(variable, values[variable]!);
    try {
      const handle = await bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(),
        realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => repository }),
      });
      expect(await fs.readFile(path.join(handle.binding.sourceRoots[0]!.path, 'content.txt'), 'utf8')).toBe(
        'selected revision',
      );
      expect(await fs.readFile(path.join(outside, 'index'))).toEqual(originalIndex);
      expect(await fs.readFile(path.join(repository, '.git/index'))).toEqual(originalIndex);
      expect(await fs.readFile(path.join(repository, '.git/HEAD'))).toEqual(originalHead);
      expect(await fs.readdir(outside)).toEqual(['index', 'sentinel']);
      expect(await fs.readFile(path.join(outside, 'sentinel'), 'utf8')).toBe('keep');
      await handle.release();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    'tree',
    'blob',
    'tag',
  ] as const)('rejects a fetched %s object before checkout and retains partial files', async (type) => {
    if (type === 'tag') {
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.com',
          '-c',
          'tag.gpgsign=false',
          'tag',
          '-a',
          'selected-tag',
          '-m',
          'annotated',
          firstRevision,
        ],
        { cwd: repository },
      );
    }
    const expression =
      type === 'tree'
        ? `${firstRevision}^{tree}`
        : type === 'blob'
          ? `${firstRevision}:content.txt`
          : 'refs/tags/selected-tag';
    const revision = execFileSync('git', ['rev-parse', expression], {
      cwd: repository,
      encoding: 'utf8',
    }).trim();
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(revision),
        realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => repository }),
      }),
    ).rejects.toThrow('Git source revision must identify a commit object');
    const root = path.join(workspaceRoot, 'sources/project');
    expect(execFileSync('git', ['cat-file', '-t', revision], { cwd: root, encoding: 'utf8' }).trim()).toBe(type);
    await expect(fs.stat(path.join(root, '.git/index'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(path.join(root, 'content.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects failed checkout of a valid commit and retains partial files without a binding', async () => {
    const gitOptions = { cwd: repository, encoding: 'utf8' as const };
    const blob = execFileSync('git', ['rev-parse', `${firstRevision}:content.txt`], gitOptions).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${'x'.repeat(300)}`], gitOptions);
    const tree = execFileSync('git', ['write-tree'], gitOptions).trim();
    const revision = execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree,
        '-p',
        firstRevision,
        '-m',
        'unrepresentable filename',
      ],
      gitOptions,
    ).trim();
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(revision),
        realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => repository }),
      }),
    ).rejects.toThrow('Git source checkout failed');
    const root = path.join(workspaceRoot, 'sources/project');
    expect(execFileSync('git', ['cat-file', '-t', revision], { cwd: root, encoding: 'utf8' }).trim()).toBe('commit');
    expect((await fs.stat(path.join(root, '.git'))).isDirectory()).toBe(true);
  });

  it('reports fetch failure without returning a usable binding', async () => {
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(),
        realizeSource: createLocalGitSourceRealizer({ timeoutMs: 5_000, resolveRepository: async () => temporaryRoot }),
      }),
    ).rejects.toThrow('Git source fetch failed');
    expect((await fs.stat(workspaceRoot)).isDirectory()).toBe(true);
  });

  it.each([
    'HEAD',
    'main',
    'HEAD~1',
    '123abcd',
    '--orphan',
  ])('rejects mutable or non-object revision %s before source access', async (revision) => {
    let accesses = 0;
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(revision),
        realizeSource: createLocalGitSourceRealizer({
          timeoutMs: 5_000,
          resolveRepository: async () => {
            accesses += 1;
            return repository;
          },
        }),
      }),
    ).rejects.toThrow('Git source revision must be a full commit object ID');
    expect(accesses).toBe(0);
  });

  it.each([
    'resolver',
    'realpath',
    'unrelated-after-abort',
  ] as const)('keeps %s access failures value-free', async (failure) => {
    const abort = new AbortController();
    const privateLocator = path.join(temporaryRoot, 'private-location');
    const error = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement(),
      signal: abort.signal,
      realizeSource: createLocalGitSourceRealizer({
        timeoutMs: 5_000,
        resolveRepository: async () => {
          if (failure === 'realpath') return privateLocator;
          if (failure === 'unrelated-after-abort') abort.abort('stop');
          throw new Error(`Access denied at ${privateLocator}`);
        },
      }),
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: 'Git source access failed' });
    expect(String(error)).not.toContain(privateLocator);
    expect(error).not.toHaveProperty('cause');
  });

  it('preserves a real Node cancellation from repository access', async () => {
    const abort = new AbortController();
    const reason = new Error('stop source resolution');
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(),
        signal: abort.signal,
        realizeSource: createLocalGitSourceRealizer({
          timeoutMs: 5_000,
          resolveRepository: async (_id, signal) => {
            const pending = delay(10_000, repository, { signal });
            abort.abort(reason);
            return await pending;
          },
        }),
      }),
    ).rejects.toMatchObject({ name: 'AbortError', code: 'ABORT_ERR', cause: reason });
  });

  it('forwards cancellation to source access and starts no Git command after cancellation', async () => {
    const abort = new AbortController();
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement(),
        signal: abort.signal,
        realizeSource: createLocalGitSourceRealizer({
          timeoutMs: 5_000,
          resolveRepository: async (_id, signal) => {
            expect(signal).toBe(abort.signal);
            abort.abort();
            return repository;
          },
        }),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await fs.readdir(path.join(workspaceRoot, 'sources/project'))).toEqual([]);
  });
});
