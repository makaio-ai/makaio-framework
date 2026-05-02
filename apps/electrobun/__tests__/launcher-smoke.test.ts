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
 * The test uses `execFileSync` (not `execSync`) to avoid shell interpretation
 * of the bundle path and to keep argument handling explicit.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_BUNDLE = path.join(PACKAGE_ROOT, 'dist', 'cli.mjs');

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
    execFileSync('bun', ['run', 'build.ts'], {
      cwd: PACKAGE_ROOT,
      stdio: 'inherit',
      timeout: 120_000,
    });
  }, 130_000);

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
