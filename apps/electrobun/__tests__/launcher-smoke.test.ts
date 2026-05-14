/**
 * Smoke tests for the CLI launcher bundle (`dist/cli.mjs`).
 *
 * Verifies that the Bun-bundled CLI entrypoint:
 * - Exists as a built artifact.
 * - Can be executed by Bun without errors.
 * - Returns the expected version string for `--version`.
 * - Returns help text that names the program and the built-in `serve` command
 *   for `--help`.
 *
 * These tests invoke the real build before checking the launcher so they do
 * not depend on test file execution order or on stale local artifacts.
 *
 * Execution tests (--version, --help) require runtime-consumable
 * `@makaio/framework` output (`yarn build:framework`). When both lib and dist
 * are absent, these tests are skipped — the bundle contains externalized
 * framework imports that Bun cannot resolve without the assembled package.
 *
 * The test uses `execFileSync` (not `execSync`) to avoid shell interpretation
 * of the bundle path and to keep argument handling explicit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireElectrobunBuildLock } from './build-test-lock.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_BUNDLE = path.join(PACKAGE_ROOT, 'dist', 'cli.mjs');
const FRAMEWORK_PACKAGE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', 'packages', 'framework');
const FRAMEWORK_LIB = path.join(FRAMEWORK_PACKAGE_ROOT, 'lib');
const FRAMEWORK_DIST = path.join(FRAMEWORK_PACKAGE_ROOT, 'dist');
const FRAMEWORK_PACKAGE_LINK = path.join(PACKAGE_ROOT, 'node_modules', '@makaio', 'framework');
const hasFrameworkPackage = existsSync(FRAMEWORK_LIB) || existsSync(FRAMEWORK_DIST);
const itRequiresFramework = hasFrameworkPackage ? it : it.skip;
let releaseBuildLock: (() => void) | undefined;
let createdFrameworkPackageLink = false;

/**
 * Shared env for all CLI invocations.
 *
 * Provides an isolated `MAKAIO_HOME` so the CLI does not read the developer's
 * real home directory during tests. The directory need not exist — the CLI
 * handles missing home directories gracefully for read-only commands.
 */
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MAKAIO_HOME: path.join(PACKAGE_ROOT, '.test-makaio-home'),
};

describe('CLI launcher smoke test', () => {
  beforeAll(() => {
    releaseBuildLock = acquireElectrobunBuildLock();
    try {
      execFileSync('bun', ['run', 'build.ts'], {
        cwd: PACKAGE_ROOT,
        stdio: 'inherit',
        timeout: 120_000,
      });
      if (hasFrameworkPackage) {
        ensureLocalFrameworkPackageLink();
      }
    } catch (error) {
      removeLocalFrameworkPackageLink();
      releaseBuildLockNow();
      throw error;
    }
  }, 240_000);

  afterAll(() => {
    removeLocalFrameworkPackageLink();
    releaseBuildLockNow();
  });

  it('dist/cli.mjs exists after build', () => {
    expect(existsSync(CLI_BUNDLE)).toBe(true);
  });

  itRequiresFramework('bun can execute --version', () => {
    const result = execFileSync('bun', [CLI_BUNDLE, '--version'], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: TEST_ENV,
    }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+/);
  });

  itRequiresFramework('bun can execute --help', () => {
    const result = execFileSync('bun', [CLI_BUNDLE, '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: TEST_ENV,
    }).trim();
    expect(result).toContain('makaio');
    expect(result).toContain('serve');
  });
});

/**
 * Release the shared build lock if this test file owns it.
 */
function releaseBuildLockNow(): void {
  releaseBuildLock?.();
  releaseBuildLock = undefined;
}

/**
 * Provide the local assembled framework package through the same package name
 * the Electrobun bundle uses in packaged app layouts.
 */
function ensureLocalFrameworkPackageLink(): void {
  if (pathExists(FRAMEWORK_PACKAGE_LINK)) {
    assertFrameworkPackageLinkTarget();
    return;
  }
  mkdirSync(path.dirname(FRAMEWORK_PACKAGE_LINK), { recursive: true });
  symlinkSync(FRAMEWORK_PACKAGE_ROOT, FRAMEWORK_PACKAGE_LINK, 'dir');
  createdFrameworkPackageLink = true;
}

/**
 * Verify that an existing runtime framework package path targets this checkout.
 */
function assertFrameworkPackageLinkTarget(): void {
  if (realpathSync(FRAMEWORK_PACKAGE_LINK) === realpathSync(FRAMEWORK_PACKAGE_ROOT)) return;
  throw new Error(`${FRAMEWORK_PACKAGE_LINK} exists but does not resolve to ${FRAMEWORK_PACKAGE_ROOT}.`);
}

/**
 * Remove the runtime package link created by this test file.
 */
function removeLocalFrameworkPackageLink(): void {
  if (!createdFrameworkPackageLink) return;
  rmSync(FRAMEWORK_PACKAGE_LINK, { force: true, recursive: true });
  createdFrameworkPackageLink = false;
}

/**
 * Checks whether a path exists, counting broken symlinks as occupied paths.
 * @param targetPath - Filesystem path to inspect.
 * @returns `true` when the path exists or is an existing symlink.
 */
function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch (error) {
    if (isNodeNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Checks whether a thrown filesystem error is an ENOENT.
 * @param error - Unknown error thrown by a filesystem call.
 * @returns `true` when the error carries Node's ENOENT code.
 */
function isNodeNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
