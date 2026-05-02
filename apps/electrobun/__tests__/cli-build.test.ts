/**
 * Integration test for the Electrobun build script.
 *
 * Runs `bun run build.ts` and asserts that:
 * - `dist/cli.mjs` is produced by the CLI build target.
 * - `dist/variant.json` is emitted with the correct shape for the active variant.
 *
 * This test intentionally invokes the real build to avoid a false coverage
 * impression from mocking the file system or the Bun build APIs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VariantConfig } from '../src/variant-config.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const DIST_DIR = path.join(PACKAGE_ROOT, 'dist');

/**
 * Runs `bun run build.ts` from the electrobun package root.
 * @param env - Additional environment variables to pass to the build.
 */
function runBuild(env: Record<string, string> = {}): void {
  execFileSync('bun', ['run', 'build.ts'], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
}

describe('electrobun build outputs', () => {
  it('produces dist/cli.mjs', () => {
    runBuild();
    expect(existsSync(path.join(DIST_DIR, 'cli.mjs'))).toBe(true);
  });

  it('produces dist/variant.json with the base variant by default', () => {
    runBuild();
    const raw = readFileSync(path.join(DIST_DIR, 'variant.json'), 'utf-8');
    const config: VariantConfig = JSON.parse(raw);
    expect(config).toEqual({
      variant: 'base',
      releaseTrack: 'stable',
      updateChannel: 'stable',
      bundleCEF: false,
      defaultRenderer: 'native',
    });
  });

  it('produces dist/variant.json with the cef variant when MAKAIO_VARIANT=cef', () => {
    runBuild({ MAKAIO_VARIANT: 'cef' });
    const raw = readFileSync(path.join(DIST_DIR, 'variant.json'), 'utf-8');
    const config: VariantConfig = JSON.parse(raw);
    expect(config).toEqual({
      variant: 'cef',
      releaseTrack: 'stable',
      updateChannel: 'cef',
      bundleCEF: true,
      defaultRenderer: 'cef',
    });
  });

  it('produces dist/variant.json with the cef-canary channel when both env vars are set', () => {
    runBuild({ MAKAIO_VARIANT: 'cef', MAKAIO_RELEASE_TRACK: 'canary' });
    const raw = readFileSync(path.join(DIST_DIR, 'variant.json'), 'utf-8');
    const config: VariantConfig = JSON.parse(raw);
    expect(config).toEqual({
      variant: 'cef',
      releaseTrack: 'canary',
      updateChannel: 'cef-canary',
      bundleCEF: true,
      defaultRenderer: 'cef',
    });
  });
});
