/**
 * tsgo-based declaration emit and framework import rewriting.
 *
 * Provides a two-step pipeline for extension and package builds:
 * 1. Emit `.d.ts` declarations via tsgo (`--noCheck` separates declaration
 * emit from type checking, which belongs in `yarn validate`).
 * 2. Rewrite workspace `@makaio/*` specifiers to their stable
 * `@makaio/framework/<subpath>` form in all emitted declaration files.
 * @packageDocumentation
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { rewriteFrameworkImportsInText } from '@makaio/build-tooling/framework-import-map';
import { createLocalBinPathEnv } from '@makaio/build-tooling/process-env';

const require = createRequire(import.meta.url);
const tsgoPackageJson = require.resolve('@typescript/native-preview/package.json');
const tsgoBinPath = join(dirname(tsgoPackageJson), 'bin', 'tsgo.js');

/**
 * Options for {@link emitDeclarations}.
 */
export interface EmitDeclarationsOptions {
  /**
   * Absolute path to the package directory (where tsconfig.build.json lives).
   * Defaults to the caller's `import.meta.dirname` — must be supplied explicitly
   * since this module cannot infer the caller's location.
   */
  readonly packageDir: string;

  /**
   * Path to the tsconfig used for declaration emit, relative to `packageDir`.
   * Defaults to `'tsconfig.build.json'`.
   */
  readonly tsconfig?: string;

  /**
   * Absolute path to the output directory containing emitted `.d.ts` files.
   * Defaults to `<packageDir>/dist`.
   */
  readonly outDir?: string;

  /**
   * Whether to rewrite framework-owned workspace imports after emit.
   * Defaults to `true`.
   */
  readonly rewriteImports?: boolean;
}

/**
 * Recursively rewrite framework-owned import specifiers in all `.d.ts` and
 * `.d.mts` files under the given directory.
 * @param dir - Root directory to walk.
 */
export function rewriteDeclarationImports(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDeclarationImports(fullPath);
    } else if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.mts')) {
      const content = readFileSync(fullPath, 'utf8');
      const rewritten = rewriteFrameworkImportsInText(content);
      if (rewritten !== content) {
        writeFileSync(fullPath, rewritten);
      }
    }
  }
}

/**
 * Emit type declarations via tsgo and optionally rewrite framework imports.
 *
 * Runs `tsgo --project <tsconfig> --noCheck` to produce per-file `.d.ts`
 * output, then walks the output directory to rewrite `@makaio/*` workspace
 * specifiers to their `@makaio/framework/<subpath>` equivalents.
 * @param options - Emit configuration.
 */
export function emitDeclarations(options: EmitDeclarationsOptions): void {
  const {
    packageDir,
    tsconfig = 'tsconfig.build.json',
    outDir = join(packageDir, 'dist'),
    rewriteImports = true,
  } = options;

  console.info('[tsgo] Emitting declarations…');
  execFileSync(process.execPath, [tsgoBinPath, '--project', tsconfig, '--noCheck'], {
    stdio: 'inherit',
    cwd: packageDir,
    env: createLocalBinPathEnv({ startDir: packageDir }),
  });

  if (rewriteImports) {
    console.info('[tsgo] Rewriting framework imports in declarations…');
    rewriteDeclarationImports(outDir);
  }
}
