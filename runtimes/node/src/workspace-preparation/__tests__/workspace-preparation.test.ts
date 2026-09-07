import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRequirement } from '@makaio/contracts';
import { bindLocalWorkspace } from '../workspace-preparation.js';

let temporaryRoot: string;
let workspaceRoot: string;

beforeEach(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-preparation-'));
  workspaceRoot = path.join(temporaryRoot, 'workspace');
});

afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

/**
 * Small explicit scratch requirement, with custody independent of provisioning.
 * @param overrides - Per-test behavior.
 * @returns Portable requirement with no preservation or acquisition machinery.
 */
function requirement(overrides: Partial<WorkspaceRequirement> = {}): WorkspaceRequirement {
  return { provisioning: 'create', custody: 'disposable', sourceRoots: [], setup: [], ...overrides };
}

describe('local workspace preparation', () => {
  it('creates scratch with zero source roots and releases only the selected root once', async () => {
    const sibling = path.join(temporaryRoot, 'keep');
    await fs.writeFile(sibling, 'retained');
    const handle = await bindLocalWorkspace({ workspaceRoot, requirement: requirement() });
    expect(handle.binding).toEqual({ workspaceRoot: await fs.realpath(workspaceRoot), sourceRoots: [] });
    expect(await handle.runSetup()).toEqual({ status: 'completed', exitCode: 0 });
    await handle.release();
    await fs.mkdir(workspaceRoot);
    await handle.release();
    expect((await fs.stat(workspaceRoot)).isDirectory()).toBe(true);
    expect(await fs.readFile(sibling, 'utf8')).toBe('retained');
  });

  it.each(['bind', 'create'] as const)('preserves external custody with %s provisioning', async (provisioning) => {
    if (provisioning === 'bind') await fs.mkdir(workspaceRoot);
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement({ provisioning, custody: 'external' }),
    });
    await fs.writeFile(path.join(workspaceRoot, 'human-work'), 'uncommitted');
    await handle.release();
    expect(await fs.readFile(path.join(workspaceRoot, 'human-work'), 'utf8')).toBe('uncommitted');
  });

  it('can release an adopted root when custody separately makes it disposable', async () => {
    await fs.mkdir(workspaceRoot);
    const handle = await bindLocalWorkspace({ workspaceRoot, requirement: requirement({ provisioning: 'bind' }) });
    await handle.release();
    await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates one contained source directory and returns its local path', async () => {
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement({ sourceRoots: [{ id: 'source', path: 'sources/project' }] }),
    });
    expect(handle.binding.sourceRoots).toEqual([
      { id: 'source', path: path.join(await fs.realpath(workspaceRoot), 'sources/project') },
    ]);
  });

  it('binds an existing source root without requiring Git or clean files', async () => {
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, 'untracked'), 'in progress');
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement({ provisioning: 'bind', sourceRoots: [{ id: 'source', path: '.' }] }),
    });
    expect(handle.binding.sourceRoots[0]?.path).toBe(await fs.realpath(workspaceRoot));
  });

  it('rejects multiple roots and unsupported sources before creating anything', async () => {
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement({
          sourceRoots: [
            { id: 'a', path: 'a' },
            { id: 'b', path: 'b' },
          ],
        }),
      }),
    ).rejects.toThrow('Multiple source roots');
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement({ sourceRoots: [{ id: 'a', path: 'a', source: { kind: 'git', input: {} } }] }),
      }),
    ).rejects.toThrow('Source acquisition');
    await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects root replacement, relative locators and source path escapes', async () => {
    await fs.mkdir(workspaceRoot);
    await expect(bindLocalWorkspace({ workspaceRoot, requirement: requirement() })).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(bindLocalWorkspace({ workspaceRoot: 'relative', requirement: requirement() })).rejects.toThrow(
      'absolute',
    );
    await expect(bindLocalWorkspace({ workspaceRoot: '/', requirement: requirement() })).rejects.toThrow(
      'non-filesystem-root',
    );
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement({ provisioning: 'bind', sourceRoots: [{ id: 'a', path: '../outside' }] }),
      }),
    ).rejects.toThrow('workspace-relative');
  });

  it('rejects a source symlink escaping the workspace, even when its child is missing', async () => {
    await fs.mkdir(workspaceRoot);
    const outside = path.join(temporaryRoot, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspaceRoot, 'escape'));
    await expect(
      bindLocalWorkspace({
        workspaceRoot,
        requirement: requirement({ provisioning: 'bind', sourceRoots: [{ id: 'a', path: 'escape/missing' }] }),
      }),
    ).rejects.toThrow('symlink');
    await expect(fs.stat(path.join(outside, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs frozen commands in order and retains files on first setup failure', async () => {
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement({
        setup: [
          {
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('first','ready')"],
            env: {},
            timeoutMs: 5_000,
          },
          { command: process.execPath, args: ['-e', 'process.exit(7)'], env: {}, timeoutMs: 5_000 },
          {
            command: process.execPath,
            args: ['-e', "require('fs').writeFileSync('never','ran')"],
            env: {},
            timeoutMs: 5_000,
          },
        ],
      }),
    });
    expect(await handle.runSetup()).toEqual({ status: 'failed', exitCode: 7, commandIndex: 1 });
    expect(await fs.readFile(path.join(workspaceRoot, 'first'), 'utf8')).toBe('ready');
    await expect(fs.stat(path.join(workspaceRoot, 'never'))).rejects.toMatchObject({ code: 'ENOENT' });
    await handle.release();
    await expect(fs.stat(workspaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses release during setup and permits it after cancellation completes', async () => {
    const handle = await bindLocalWorkspace({
      workspaceRoot,
      requirement: requirement({
        setup: [{ command: process.execPath, args: ['-e', 'setInterval(()=>{},100)'], env: {}, timeoutMs: 5_000 }],
      }),
    });
    const abort = new AbortController();
    const running = handle.runSetup({ signal: abort.signal });
    await expect(handle.release()).rejects.toThrow('not stopped');
    abort.abort();
    expect(await running).toMatchObject({ status: 'cancelled', commandIndex: 0 });
    await handle.release();
    await expect(handle.runSetup()).rejects.toThrow('unavailable');
  });
});
