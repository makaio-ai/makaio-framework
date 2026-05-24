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
 * These tests invoke the real Electrobun build before checking the launcher.
 * They also ensure the assembled `@makaio/framework` runtime output is fresh,
 * because the launcher bundle externalizes framework imports to package
 * subpaths consumed from `packages/framework/dist`.
 *
 * The test uses `execFileSync` (not `execSync`) to avoid shell interpretation
 * of the bundle path and to keep argument handling explicit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isFrameworkDistFresh } from '../../../packages/framework/build-fingerprint.js';
import { acquireElectrobunBuildLock } from './build-test-lock.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const CLI_BUNDLE = path.join(PACKAGE_ROOT, 'dist', 'cli.mjs');
const FRAMEWORK_PACKAGE_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', 'packages', 'framework');
const FRAMEWORK_DIST = path.join(FRAMEWORK_PACKAGE_ROOT, 'dist');
const FRAMEWORK_PACKAGE_LINK = path.join(PACKAGE_ROOT, 'node_modules', '@makaio', 'framework');
const REQUIRED_FRAMEWORK_EXPORT = 'FrameworkContractNamespaces';
const REQUIRED_FRAMEWORK_FILES = ['utils/workspace-packages.mjs'];
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
      ensureFreshFrameworkDist();
      execFileSync('bun', ['run', 'build.ts'], {
        cwd: PACKAGE_ROOT,
        stdio: 'inherit',
        timeout: 120_000,
      });
      assertFrameworkRuntimeOutput();
      ensureLocalFrameworkPackageLink();
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

  it('bun can execute --version', () => {
    const result = execFileSync('bun', [CLI_BUNDLE, '--version'], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: TEST_ENV,
    }).trim();
    expect(result).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('bun can execute --help', () => {
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
 * Build framework dist only when the current output is missing or stale.
 */
function ensureFreshFrameworkDist(): void {
  if (
    isFrameworkDistFresh({
      workspaceRoot: WORKSPACE_ROOT,
      distDir: FRAMEWORK_DIST,
      requiredFiles: REQUIRED_FRAMEWORK_FILES,
    })
  ) {
    return;
  }

  execFileSync('yarn', ['run', '-T', 'build:framework'], {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
    timeout: 180_000,
  });
}

/**
 * Verify that assembled framework output contains the runtime surface needed by
 * the launcher bundle.
 */
function assertFrameworkRuntimeOutput(): void {
  if (!frameworkOutputExports(FRAMEWORK_DIST, REQUIRED_FRAMEWORK_EXPORT)) {
    throw new Error(`Framework dist does not export ${REQUIRED_FRAMEWORK_EXPORT}.`);
  }
  for (const filePath of REQUIRED_FRAMEWORK_FILES) {
    if (!existsSync(path.join(FRAMEWORK_DIST, filePath))) {
      throw new Error(`Framework dist is missing required runtime file: ${filePath}`);
    }
  }
}

/**
 * Release the shared build lock if this test file owns it.
 */
function releaseBuildLockNow(): void {
  releaseBuildLock?.();
  releaseBuildLock = undefined;
}

/**
 * Check whether assembled framework output contains a runtime export.
 * @param outputRoot - Candidate framework output root (`lib` or `dist`).
 * @param exportName - Runtime export name required by the launcher bundle.
 * @returns True when the output's contracts entrypoint exports the name.
 */
function frameworkOutputExports(outputRoot: string, exportName: string): boolean {
  const entrypoint = path.join(outputRoot, 'contracts', 'index.mjs');
  if (!existsSync(entrypoint)) return false;
  return sourceExportsName(readFileSync(entrypoint, 'utf8'), exportName);
}

/**
 * Escape a string for use inside a regular expression.
 * @param value - Literal string to escape.
 * @returns Regex-safe version of the value.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether source text actually exports a given name.
 * @param source - JavaScript module source to inspect.
 * @param exportName - Exported name to find.
 * @returns True when the source declares or re-exports `exportName`.
 */
function sourceExportsName(source: string, exportName: string): boolean {
  const escapedExportName = escapeRegExp(exportName);
  if (new RegExp(`\\bexport\\s+(?:const|let|var|function|class)\\s+${escapedExportName}\\b`).test(source)) {
    return true;
  }
  if (new RegExp(`\\bexport\\s+default\\s+${escapedExportName}\\b`).test(source)) {
    return true;
  }

  for (const match of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    const exportList = match[1] ?? '';
    for (const specifier of exportList.split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const exportedName = parts.length > 1 ? parts.at(-1)?.trim() : parts[0]?.trim();
      if (exportedName === exportName) return true;
    }
  }

  return false;
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

describe('framework output export detection', () => {
  it('matches real ES export syntax only', () => {
    expect(sourceExportsName('export const FrameworkContractNamespaces = [];', REQUIRED_FRAMEWORK_EXPORT)).toBe(true);
    expect(
      sourceExportsName('const Fa = []; export { Fa as FrameworkContractNamespaces };', REQUIRED_FRAMEWORK_EXPORT),
    ).toBe(true);
    expect(sourceExportsName('const FrameworkContractNamespaces = [];', REQUIRED_FRAMEWORK_EXPORT)).toBe(false);
    expect(sourceExportsName('export { FrameworkContractNamespaces as OtherName };', REQUIRED_FRAMEWORK_EXPORT)).toBe(
      false,
    );
  });
});
