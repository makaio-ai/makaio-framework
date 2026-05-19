import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  readPackageVersion,
  resolvePackageSetRoot,
  resolveRuntimeNodePackageJsonPath,
  resolveStorageMigrationsDir,
  resolveWorkspaceRoot,
} from '@makaio/host-shared/build/workspace-paths';

describe('resolveWorkspaceRoot', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the prefixed source workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-workspace-root-'));
    tempDirs.push(root);
    const packageRoot = path.join(root, 'framework', 'apps', 'electrobun');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    writeFileSync(path.join(root, 'framework', 'package.json'), '{}\n', 'utf-8');

    expect(resolveWorkspaceRoot(packageRoot)).toBe(root);
  });

  it('resolves the package-root source workspace root', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-workspace-root-'));
    tempDirs.push(root);
    const packageRoot = path.join(root, 'apps', 'electrobun');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');

    expect(resolveWorkspaceRoot(packageRoot)).toBe(root);
  });

  it('does not overshoot a package-root checkout named framework', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-workspace-root-'));
    tempDirs.push(parent);
    const root = path.join(parent, 'framework');
    const packageRoot = path.join(root, 'apps', 'electrobun');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');

    expect(resolveWorkspaceRoot(packageRoot)).toBe(root);
  });
});

describe('resolveStorageMigrationsDir', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the migrations directory in the prefixed source layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-workspace-paths-'));
    tempDirs.push(root);

    const packageRoot = path.join(root, 'framework', 'apps', 'electron');
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    mkdirSync(path.join(root, 'framework', 'packages', 'storage-migrations', 'drizzle'), { recursive: true });

    expect(resolveStorageMigrationsDir(packageRoot)).toBe(
      path.join(root, 'framework', 'packages', 'storage-migrations', 'drizzle'),
    );
  });

  it('resolves the migrations directory in the package-root layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-workspace-paths-'));
    tempDirs.push(root);

    const packageRoot = path.join(root, 'apps', 'electron');
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    mkdirSync(path.join(root, 'packages', 'storage-migrations', 'drizzle'), { recursive: true });

    expect(resolveStorageMigrationsDir(packageRoot)).toBe(path.join(root, 'packages', 'storage-migrations', 'drizzle'));
  });

  it('throws when neither supported source layout contains storage migrations', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-workspace-paths-'));
    tempDirs.push(root);

    const packageRoot = path.join(root, 'framework', 'apps', 'electron');
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');
    mkdirSync(packageRoot, { recursive: true });

    expect(() => resolveStorageMigrationsDir(packageRoot)).toThrow(/Could not resolve storage migrations directory/);
  });
});

describe('resolvePackageSetRoot', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns the nested package-set directory in the prefixed source layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-package-set-root-'));
    tempDirs.push(root);
    mkdirSync(path.join(root, 'framework'), { recursive: true });
    writeFileSync(path.join(root, 'framework', 'package.json'), '{}\n', 'utf-8');

    expect(resolvePackageSetRoot(root)).toBe(path.join(root, 'framework'));
  });

  it('returns the workspace root in the package-root source layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-package-set-root-'));
    tempDirs.push(root);
    writeFileSync(path.join(root, 'package.json'), '{}\n', 'utf-8');

    expect(resolvePackageSetRoot(root)).toBe(root);
  });
});

describe('resolveRuntimeNodePackageJsonPath', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves runtime-node metadata in the prefixed source layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-runtime-node-'));
    tempDirs.push(root);
    mkdirSync(path.join(root, 'framework'), { recursive: true });
    writeFileSync(path.join(root, 'framework', 'package.json'), '{}\n', 'utf-8');
    const packageJsonPath = path.join(root, 'framework', 'runtimes', 'node', 'package.json');
    mkdirSync(path.dirname(packageJsonPath), { recursive: true });
    writeFileSync(packageJsonPath, '{"version":"1.2.3"}\n', 'utf-8');

    expect(resolveRuntimeNodePackageJsonPath(root)).toBe(packageJsonPath);
  });

  it('resolves runtime-node metadata in the package-root layout', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-runtime-node-'));
    tempDirs.push(root);
    const packageJsonPath = path.join(root, 'runtimes', 'node', 'package.json');
    mkdirSync(path.dirname(packageJsonPath), { recursive: true });
    writeFileSync(packageJsonPath, '{"version":"1.2.3"}\n', 'utf-8');

    expect(resolveRuntimeNodePackageJsonPath(root)).toBe(packageJsonPath);
  });
});

describe('readPackageVersion', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a non-empty package version', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-package-version-'));
    tempDirs.push(root);
    const packageJsonPath = path.join(root, 'package.json');
    writeFileSync(packageJsonPath, '{"version":"1.2.3"}\n', 'utf-8');

    expect(readPackageVersion(packageJsonPath)).toBe('1.2.3');
  });

  it('rejects package metadata without a version', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'makaio-host-shared-package-version-'));
    tempDirs.push(root);
    const packageJsonPath = path.join(root, 'package.json');
    writeFileSync(packageJsonPath, '{}\n', 'utf-8');

    expect(() => readPackageVersion(packageJsonPath)).toThrow(/expected a non-empty string "version"/);
  });
});
