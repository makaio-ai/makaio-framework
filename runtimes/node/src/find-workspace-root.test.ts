import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspaceRoot, findWorkspaceRootInfo, WorkspaceRootNotFoundError } from './find-workspace-root.js';

describe('findWorkspaceRoot', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'makaio-workspace-root-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds the nearest package.json with workspaces from a nested directory', async () => {
    const nestedDir = path.join(tmpDir, 'runtimes', 'node', 'dist');
    await fs.promises.mkdir(nestedDir, { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));

    expect(findWorkspaceRoot(nestedDir)).toBe(tmpDir);
  });

  it('returns parsed root package metadata when requested', async () => {
    const nestedDir = path.join(tmpDir, 'runtimes', 'node', 'dist');
    await fs.promises.mkdir(nestedDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', '!packages/excluded'] }),
    );

    expect(findWorkspaceRootInfo(nestedDir)).toEqual({
      root: tmpDir,
      packageJsonPath: path.join(tmpDir, 'package.json'),
      workspaces: ['packages/*', '!packages/excluded'],
    });
  });

  it('supports object-form workspace package declarations', async () => {
    const nestedDir = path.join(tmpDir, 'runtimes', 'node', 'dist');
    await fs.promises.mkdir(nestedDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ workspaces: { packages: ['packages/*'] } }),
    );

    expect(findWorkspaceRootInfo(nestedDir).workspaces).toEqual(['packages/*']);
  });

  it('throws a typed error when no workspace root is found', async () => {
    const nestedDir = path.join(tmpDir, 'standalone', 'dist');
    await fs.promises.mkdir(nestedDir, { recursive: true });

    expect(() => findWorkspaceRoot(nestedDir)).toThrow(WorkspaceRootNotFoundError);
  });

  it('continues walking upward when a nested package.json is malformed', async () => {
    const nestedDir = path.join(tmpDir, 'runtimes', 'node', 'dist');
    const packageDir = path.join(tmpDir, 'runtimes', 'node');
    await fs.promises.mkdir(nestedDir, { recursive: true });
    await fs.promises.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    await fs.promises.writeFile(path.join(packageDir, 'package.json'), '{');

    expect(findWorkspaceRoot(nestedDir)).toBe(tmpDir);
  });
});
