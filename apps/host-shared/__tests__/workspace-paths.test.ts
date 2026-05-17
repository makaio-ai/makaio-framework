import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveStorageMigrationsDir } from '@makaio/host-shared/build/workspace-paths';

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
