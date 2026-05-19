import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { createLocalBinPathEnv } from '../process-env.js';

const tempRoots: string[] = [];

function createFixture(): { readonly root: string; readonly packageDir: string; readonly binDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'makaio-process-env-'));
  tempRoots.push(root);

  const binDir = join(root, 'node_modules', '.bin');
  const packageDir = join(root, 'extensions', 'demo');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(packageDir, { recursive: true });

  return { root, packageDir, binDir };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('createLocalBinPathEnv', () => {
  it('prepends the nearest local binary directory to PATH', () => {
    const { packageDir, binDir } = createFixture();

    const env = createLocalBinPathEnv({
      startDir: packageDir,
      env: { PATH: 'existing-bin' },
    });

    expect(env.PATH).toBe([binDir, 'existing-bin'].join(delimiter));
  });

  it('uses Windows-style Path when PATH is absent', () => {
    const { packageDir, binDir } = createFixture();

    const env = createLocalBinPathEnv({
      startDir: packageDir,
      env: { Path: 'existing-bin' },
    });

    expect(env.PATH).toBe([binDir, 'existing-bin'].join(delimiter));
  });

  it('finds the closest ancestor node_modules directory', () => {
    const { packageDir, binDir } = createFixture();
    const nestedBinDir = join(packageDir, 'node_modules', '.bin');
    const nestedSourceDir = join(packageDir, 'src');
    mkdirSync(nestedBinDir, { recursive: true });
    mkdirSync(nestedSourceDir, { recursive: true });

    const env = createLocalBinPathEnv({
      startDir: nestedSourceDir,
      env: {},
    });

    expect(env.PATH).toBe(nestedBinDir);
    expect(env.PATH).not.toBe(binDir);
  });
});
