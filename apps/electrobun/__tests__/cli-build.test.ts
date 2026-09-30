/**
 * Integration test for the Electrobun build script.
 *
 * Runs `bun run build.ts` and asserts that:
 * - `dist/cli.mjs` is produced by the CLI build target.
 * - `dist/variant.json` is emitted with the correct shape for the active variant.
 * - Framework imports are externalized as `@makaio/framework/*` subpaths in `cli.mjs`
 *   and its code-split `cli-chunks/*.mjs`.
 * - `cli.mjs` stays a light router: no static framework imports, and it dynamically
 *   imports the `hook-fast-path` chunk (light hook route).
 *
 * This test intentionally invokes the real build to avoid a false coverage
 * impression from mocking the file system or the Bun build APIs.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameworkExternalPackageNames } from '@makaio/build-tooling/framework-import-map';
import type { VariantConfig } from '../src/variant-config.js';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const TEST_OUTPUT_ROOT = path.join(PACKAGE_ROOT, 'dist', '.tests');
mkdirSync(TEST_OUTPUT_ROOT, { recursive: true });
const DIST_DIR = mkdtempSync(path.join(TEST_OUTPUT_ROOT, 'cli-build-'));

afterAll(() => {
  rmSync(DIST_DIR, { recursive: true, force: true });
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
 * Lists the CLI output files: `cli.mjs` plus every `cli-chunks/*.mjs` chunk.
 * @returns Paths relative to the build output directory (posix separators).
 */
function listCliOutputFiles(): string[] {
  const chunksDir = path.join(DIST_DIR, 'cli-chunks');
  const chunks = existsSync(chunksDir)
    ? readdirSync(chunksDir)
        .filter((name) => name.endsWith('.mjs'))
        .sort()
        .map((name) => `cli-chunks/${name}`)
    : [];
  return ['cli.mjs', ...chunks];
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
      env: { ...process.env, ...env, MAKAIO_ELECTROBUN_BUILD_OUTDIR: DIST_DIR },
      stdio: 'pipe',
    });
  } catch (error) {
    rmSync(DIST_DIR, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Walks relative imports (static `from "./…"` and literal `import("./…")`) starting at an entry
 * file inside the build output. Cycle-safe.
 * @param entryRel - Entry file path relative to the build output directory.
 * @returns Visited files (relative, posix) and non-relative specifiers with the file that imports them.
 */
function walkRelativeImports(entryRel: string): {
  visited: string[];
  external: Array<{ file: string; specifier: string }>;
} {
  const visited = new Set<string>();
  const external: Array<{ file: string; specifier: string }> = [];
  const queue = [entryRel];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(path.join(DIST_DIR, file), 'utf-8');
    const specifiers = [
      ...source.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g),
      ...source.matchAll(/(?:^|[;\n}])\s*import\s*(['"])([^'"]+)\1/g),
      ...source.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g),
    ].map((match) => match[2]);
    for (const specifier of specifiers) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
      } else {
        external.push({ file, specifier });
      }
    }
  }
  return { visited: [...visited], external };
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

  it('rewrites workspace specifiers to @makaio/framework/* subpaths in cli.mjs and its chunks', () => {
    const files = listCliOutputFiles();
    expect(files.length, 'expected at least one cli-chunks/*.mjs chunk next to cli.mjs').toBeGreaterThan(1);
    const combined = files.map((file) => readFileSync(path.join(DIST_DIR, file), 'utf-8')).join('\n');
    expect(combined).toMatch(/['"]@makaio\/framework\//);
  });

  it('keeps cli.mjs a light router without static @makaio/framework imports', () => {
    const source = readFileSync(path.join(DIST_DIR, 'cli.mjs'), 'utf-8');
    // Static import/export-from statements (including side-effect imports) at any position.
    const staticSpecifiers = [
      ...source.matchAll(/(?:^|[;\n}])\s*(?:import|export)\s*(?:[^'"()]*?\bfrom\s*)?(['"])([^'"]+)\1/g),
    ].map((match) => match[2]);
    const offending = staticSpecifiers.filter(
      (specifier) =>
        !specifier.startsWith('node:') &&
        !builtinModules.includes(specifier) &&
        !specifier.startsWith('./') &&
        !specifier.startsWith('../'),
    );
    expect(offending, 'cli.mjs may only statically import node built-ins and relative chunks').toEqual([]);
    expect(source).not.toMatch(/\bfrom\s*['"]@makaio\/framework/);
  });

  it('dynamically imports an existing cli-chunks/hook-fast-path-*.mjs chunk from cli.mjs', () => {
    const source = readFileSync(path.join(DIST_DIR, 'cli.mjs'), 'utf-8');
    const match = source.match(/import\(\s*['"]\.\/(cli-chunks\/hook-fast-path-[^'"]+\.mjs)['"]\s*\)/);
    expect(match, 'cli.mjs should dynamically import ./cli-chunks/hook-fast-path-*.mjs').not.toBeNull();
    expect(existsSync(path.join(DIST_DIR, match![1]))).toBe(true);
  });

  it('limits what the hook-fast-path chunk can reach to built-ins and three framework entries', () => {
    const source = readFileSync(path.join(DIST_DIR, 'cli.mjs'), 'utf-8');
    const dynamicTargets = [...source.matchAll(/import\(\s*['"]\.\/(cli-chunks\/[^'"]+\.mjs)['"]\s*\)/g)].map(
      (match) => match[1],
    );
    const hookChunk = dynamicTargets.find((target) => target.startsWith('cli-chunks/hook-fast-path-'));
    expect(hookChunk, 'cli.mjs should dynamically import a hook-fast-path chunk').toBeDefined();
    const fullChunks = dynamicTargets.filter((target) => target !== hookChunk);
    expect(fullChunks.length, 'cli.mjs should dynamically import a separate full-path chunk').toBeGreaterThan(0);

    const allowedFramework = new Set([
      '@makaio/framework/inbound-hooks/fast-connection',
      '@makaio/framework/inbound-hooks/stdio',
      '@makaio/framework/clients/hook-subjects',
    ]);
    const { visited, external } = walkRelativeImports(hookChunk!);

    const offending = external
      .filter(
        ({ specifier }) =>
          !allowedFramework.has(specifier) &&
          !builtinModules.includes(specifier.replace(/^node:/, '')) &&
          !builtinModules.includes(specifier),
      )
      .map(({ file, specifier }) => `${file} imports ${specifier}`);
    expect(offending, 'hook chunk graph may only import node built-ins and the allowed framework entries').toEqual([]);

    const reachedFull = fullChunks.filter((chunk) => visited.includes(chunk));
    expect(
      reachedFull.map((chunk) => `${hookChunk} reaches full-path chunk ${chunk}`),
      'hook chunk graph must not reach the full-path chunk',
    ).toEqual([]);
  });

  it('rewrites workspace specifiers to @makaio/framework/* subpaths in index.js', () => {
    const source = readFileSync(path.join(DIST_DIR, 'index.js'), 'utf-8');
    expect(source).toMatch(/['"]@makaio\/framework\//);
  });

  it('does not leave raw workspace specifiers in bundle output', () => {
    const workspaceNames = frameworkExternalPackageNames();

    for (const filename of ['index.js', ...listCliOutputFiles()]) {
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
