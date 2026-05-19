import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverWorkspacePackageIndex,
  discoverWorkspacePackageJsonPaths,
  parseWorkspaceGlobs,
  readWorkspaceGlobs,
  resolveWorkspacePackageJsonGlobs,
} from '../workspace-packages.js';

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('parseWorkspaceGlobs', () => {
  it('reads array-form workspace globs', () => {
    expect(parseWorkspaceGlobs({ workspaces: ['packages/*', 42, '!packages/ignored'] })).toEqual([
      'packages/*',
      '!packages/ignored',
    ]);
  });

  it('reads object-form workspace globs', () => {
    expect(parseWorkspaceGlobs({ workspaces: { packages: ['apps/*'] } })).toEqual(['apps/*']);
  });

  it('returns an empty array for missing or invalid workspace declarations', () => {
    expect(parseWorkspaceGlobs({ name: 'root' })).toEqual([]);
    expect(parseWorkspaceGlobs({ workspaces: { packages: [false] } })).toEqual([]);
  });
});

describe('resolveWorkspacePackageJsonGlobs', () => {
  it('normalizes workspace package globs for package.json scanning', () => {
    expect(resolveWorkspacePackageJsonGlobs(['packages/*', '!packages/excluded', '!apps/**'])).toEqual({
      patterns: ['packages/*/package.json'],
      ignore: ['packages/excluded/**', 'apps/**/**'],
    });
  });
});

describe('workspace package discovery', () => {
  it('reads workspace globs from the root package.json', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-workspace-packages-'));
    await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ workspaces: { packages: ['packages/*'] } }));

    await expect(readWorkspaceGlobs(tempDir)).resolves.toEqual(['packages/*']);
  });

  it('discovers workspace package descriptors and honors negated entries', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-workspace-packages-'));
    await writeFile(
      path.join(tempDir, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*', '!packages/excluded', '!packages/*-excluded'] }),
    );

    const included = path.join(tempDir, 'packages', 'included');
    const excluded = path.join(tempDir, 'packages', 'excluded');
    const wildcardExcluded = path.join(tempDir, 'packages', 'wildcard-excluded');
    await mkdir(included, { recursive: true });
    await mkdir(excluded, { recursive: true });
    await mkdir(wildcardExcluded, { recursive: true });
    await writeFile(path.join(included, 'package.json'), JSON.stringify({ name: '@acme/included' }));
    await writeFile(path.join(excluded, 'package.json'), JSON.stringify({ name: '@acme/excluded' }));
    await writeFile(path.join(wildcardExcluded, 'package.json'), JSON.stringify({ name: '@acme/wildcard-excluded' }));

    const packageJsonPaths = await discoverWorkspacePackageJsonPaths(tempDir);
    const index = await discoverWorkspacePackageIndex(tempDir);

    expect(packageJsonPaths).toEqual([path.join(included, 'package.json')]);
    expect(index).toEqual(new Map([['@acme/included', included]]));
  });

  it('skips malformed and unnamed package descriptors when building an index', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'makaio-workspace-packages-'));
    await writeFile(path.join(tempDir, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));

    const malformed = path.join(tempDir, 'packages', 'malformed');
    const unnamed = path.join(tempDir, 'packages', 'unnamed');
    const named = path.join(tempDir, 'packages', 'named');
    await mkdir(malformed, { recursive: true });
    await mkdir(unnamed, { recursive: true });
    await mkdir(named, { recursive: true });
    await writeFile(path.join(malformed, 'package.json'), '{');
    await writeFile(path.join(unnamed, 'package.json'), JSON.stringify({ version: '0.1.0' }));
    await writeFile(path.join(named, 'package.json'), JSON.stringify({ name: '@acme/named' }));

    await expect(discoverWorkspacePackageIndex(tempDir)).resolves.toEqual(new Map([['@acme/named', named]]));
  });
});
