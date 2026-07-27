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
 * They also assemble an isolated `@makaio/framework` runtime package, because
 * the launcher bundle externalizes framework imports to package subpaths.
 * That full framework + launcher build is why this lives in the desktop E2E
 * surface rather than the default unit test surface.
 *
 * The test uses `execFileSync` (not `execSync`) to avoid shell interpretation
 * of the bundle path and to keep argument handling explicit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveWorkspaceRoot } from '@makaio/utils/workspace-root';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', 'apps', 'electrobun');
const WORKSPACE_ROOT = resolveWorkspaceRoot(PACKAGE_ROOT);
const TEST_OUTPUT_ROOT = path.join(PACKAGE_ROOT, 'dist', '.tests');
mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
const TEST_ROOT = mkdtempSync(path.join(TEST_OUTPUT_ROOT, 'launcher-smoke-'));
const DIST_DIR = path.join(TEST_ROOT, 'electrobun');
const CLI_BUNDLE = path.join(DIST_DIR, 'cli.mjs');
const FRAMEWORK_PACKAGE_ROOT = path.join(DIST_DIR, 'node_modules', '@makaio', 'framework');
const FRAMEWORK_DIST = path.join(FRAMEWORK_PACKAGE_ROOT, 'dist');
const REQUIRED_FRAMEWORK_EXPORT = 'FrameworkContractNamespaces';
const REQUIRED_FRAMEWORK_FILES = ['contracts/index.mjs', 'utils/workspace-packages.mjs'];

/**
 * Shared env for all CLI invocations.
 *
 * Provides an isolated `MAKAIO_HOME` so the CLI does not read the developer's
 * real home directory during tests. The directory need not exist — the CLI
 * handles missing home directories gracefully for read-only commands.
 */
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MAKAIO_HOME: path.join(TEST_ROOT, 'home'),
};

describe('CLI launcher smoke test', () => {
  beforeAll(() => {
    try {
      buildFrameworkPackage();
      execFileSync('bun', ['run', 'build.ts'], {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, MAKAIO_ELECTROBUN_BUILD_OUTDIR: DIST_DIR },
        stdio: 'inherit',
        timeout: 120_000,
      });
      assertFrameworkRuntimeOutput();
    } catch (error) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
      throw error;
    }
  }, 450_000);

  afterAll(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
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
 * Assemble a private framework package for this test invocation.
 */
function buildFrameworkPackage(): void {
  execFileSync('yarn', ['run', '-T', 'build:framework'], {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, MAKAIO_FRAMEWORK_BUILD_PACKAGE_ROOT: FRAMEWORK_PACKAGE_ROOT },
    stdio: 'inherit',
    timeout: 300_000,
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
