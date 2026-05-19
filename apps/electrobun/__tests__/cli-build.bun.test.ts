/**
 * Integration test for the Electrobun build script.
 *
 * Runs `bun run build.ts` and asserts that:
 * - `dist/cli.mjs` is produced by the CLI build target.
 * - `dist/variant.json` is emitted with the correct shape for the active variant.
 * - Framework imports are externalized as `@makaio/framework/*` subpaths.
 *
 * This test intentionally invokes the real build to avoid a false coverage
 * impression from mocking the file system or the Bun build APIs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { frameworkExternalPackageNames } from '@makaio/build-tooling/framework-import-map';
import type { VariantConfig } from '../src/variant-config.js';
import { acquireElectrobunBuildLock } from './build-test-lock.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');
let releaseBuildLock: (() => void) | undefined;

beforeAll(() => {
  releaseBuildLock = acquireElectrobunBuildLock();
}, 180_000);

afterAll(() => {
  releaseBuildLockNow();
});

/**
 * Escapes a string for use inside a regular expression.
 * @param value - Literal string to escape.
 * @returns Regex-safe literal string.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Runs `bun run build.ts` from the electrobun package root.
 * @param env - Additional environment variables to pass to the build.
 */
function runBuild(env: Record<string, string> = {}): void {
  rmSync(DIST_DIR, { recursive: true, force: true });
  try {
    execFileSync('bun', ['run', 'build.ts'], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
  } catch (error) {
    releaseBuildLockNow();
    throw error;
  }
}

/**
 * Release the shared build lock if this test file owns it.
 */
function releaseBuildLockNow(): void {
  releaseBuildLock?.();
  releaseBuildLock = undefined;
}

describe('default electrobun build output and framework externalization', () => {
  beforeAll(() => {
    runBuild();
  });

  it('produces dist/cli.mjs', () => {
    expect(existsSync(path.join(DIST_DIR, 'cli.mjs'))).toBe(true);
  });

  it('produces dist/variant.json with the base variant by default', () => {
    const raw = readFileSync(path.join(DIST_DIR, 'variant.json'), 'utf-8');
    const config: VariantConfig = JSON.parse(raw);
    expect(config).toEqual({
      variant: 'base',
      releaseTrack: 'stable',
      electrobunBuildEnv: 'stable',
      bundleCEF: false,
      defaultRenderer: 'native',
      buildFolder: 'build/base-stable',
      artifactFolder: 'artifacts/base-stable',
    });
  });

  it('rewrites workspace specifiers to @makaio/framework/* subpaths in cli.mjs', () => {
    const source = readFileSync(path.join(DIST_DIR, 'cli.mjs'), 'utf-8');
    expect(source).toMatch(/['"]@makaio\/framework\//);
  });

  it('rewrites workspace specifiers to @makaio/framework/* subpaths in index.js', () => {
    const source = readFileSync(path.join(DIST_DIR, 'index.js'), 'utf-8');
    expect(source).toMatch(/['"]@makaio\/framework\//);
  });

  it('does not leave raw workspace specifiers in bundle output', () => {
    const workspaceNames = frameworkExternalPackageNames();

    for (const filename of ['index.js', 'cli.mjs'] as const) {
      const source = readFileSync(path.join(DIST_DIR, filename), 'utf-8');
      for (const pkg of workspaceNames) {
        const escapedPkg = escapeRegExp(pkg);
        expect(source, `${filename} should not contain raw "${pkg}" or "${pkg}/"`).not.toMatch(
          new RegExp(String.raw`['"]${escapedPkg}(?:['"]|/)`),
        );
      }
    }
  });
});

describe('electrobun variant build outputs', () => {
  describe('cef stable variant', () => {
    beforeAll(() => {
      runBuild({ MAKAIO_VARIANT: 'cef' });
    });

    it('produces dist/variant.json with the cef variant when MAKAIO_VARIANT=cef', () => {
      const raw = readFileSync(path.join(DIST_DIR, 'variant.json'), 'utf-8');
      const config: VariantConfig = JSON.parse(raw);
      expect(config).toEqual({
        variant: 'cef',
        releaseTrack: 'stable',
        electrobunBuildEnv: 'stable',
        bundleCEF: true,
        defaultRenderer: 'cef',
        buildFolder: 'build/cef-stable',
        artifactFolder: 'artifacts/cef-stable',
      });
    });
  });

  describe('cef canary variant', () => {
    beforeAll(() => {
      runBuild({ MAKAIO_VARIANT: 'cef', MAKAIO_RELEASE_TRACK: 'canary' });
    });

    it('produces dist/variant.json with canary build env when both env vars are set', () => {
      const raw = readFileSync(path.join(DIST_DIR, 'variant.json'), 'utf-8');
      const config: VariantConfig = JSON.parse(raw);
      expect(config).toEqual({
        variant: 'cef',
        releaseTrack: 'canary',
        electrobunBuildEnv: 'canary',
        bundleCEF: true,
        defaultRenderer: 'cef',
        buildFolder: 'build/cef-canary',
        artifactFolder: 'artifacts/cef-canary',
      });
    });
  });
});
