/**
 * Source-level import guard for the light CLI hook path (FACT-391).
 *
 * A hook subprocess runs once per tool call, so its module graph must stay
 * light: the detect module, the fast-path runner, the debounce helpers, and the
 * hook runner command may only load narrow subpaths. None of them imports the
 * contracts, kernel, runtime, or client subsystem barrel directly. Transitively,
 * the `@makaio/bus-core` root barrel (reached via `@makaio/inbound-hooks/fast-connection`)
 * still loads the contracts barrel today; that is accepted until FACT-392.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectRuntimeImports,
  hasDynamicImportCall,
  readManifest,
} from '@makaio/build-tooling/source-runtime-imports';
import { describe, expect, it } from 'vitest';

const cliRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const frameworkRoot = dirname(dirname(cliRoot));
const clientHooksRoot = join(frameworkRoot, 'extensions', 'client-hooks');

const detectPath = join(cliRoot, 'src', 'hook-fast-path-detect.ts');
const fastPathPath = join(cliRoot, 'src', 'hook-fast-path.ts');
const builtinDebouncePath = join(cliRoot, 'src', 'builtin-hook-debounce.ts');
const warningDebouncePath = join(cliRoot, 'src', 'warning-debounce.ts');
const hookCommandPath = join(clientHooksRoot, 'src', 'cli', 'client-hook-command.ts');

/** Barrel packages (and their subpaths' roots) that must never load on the hook path. */
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /^@makaio\/subsystem-client$/,
  /^@makaio\/inbound-hooks$/,
  // Direct ban only: the contracts barrel still loads transitively via bus-core (FACT-392).
  /^@makaio\/contracts(\/|$)/,
  /^@makaio\/runtime-node(\/|$)/,
  /^@makaio\/kernel(\/|$)/,
];

/** Frozen runtime import allowlist of the fast-path runner. */
const FAST_PATH_ALLOWED_IMPORTS = [
  './builtin-hook-debounce.js',
  '@makaio/extension-client-hooks/hook-runner',
  '@makaio/inbound-hooks/fast-connection',
  '@makaio/subsystem-client/hook-subjects',
  'node:os',
  'node:path',
];

/**
 * Return the runtime imports of a file that match a forbidden barrel pattern.
 * @param specifiers - Runtime specifiers of the file.
 * @returns Offending specifiers.
 */
function forbiddenAmong(specifiers: readonly string[]): string[] {
  return specifiers.filter((specifier) => FORBIDDEN_PATTERNS.some((pattern) => pattern.test(specifier)));
}

/**
 * Read a source file and collect its runtime imports.
 * @param filePath - Absolute source path.
 * @returns Runtime module specifiers.
 */
function runtimeImportsOf(filePath: string): string[] {
  return collectRuntimeImports(readFileSync(filePath, 'utf8'), filePath);
}

describe('light hook path import guard (hook subprocess per tool call must stay light, FACT-391)', () => {
  it('hook-fast-path-detect has no static imports and no dynamic import() call', () => {
    const source = readFileSync(detectPath, 'utf8');

    expect(collectRuntimeImports(source, detectPath)).toEqual([]);
    expect(hasDynamicImportCall(source, detectPath)).toBe(false);
  });

  it('hook-fast-path loads exactly the frozen allowlist and no barrel', () => {
    const imports = runtimeImportsOf(fastPathPath);

    expect(forbiddenAmong(imports)).toEqual([]);
    expect(imports).toEqual(FAST_PATH_ALLOWED_IMPORTS);
  });

  it('builtin-hook-debounce loads exactly warning-debounce', () => {
    const imports = runtimeImportsOf(builtinDebouncePath);

    expect(forbiddenAmong(imports)).toEqual([]);
    expect(imports).toEqual(['./warning-debounce.js']);
  });

  it('warning-debounce loads exactly its node built-ins', () => {
    const imports = runtimeImportsOf(warningDebouncePath);

    expect(forbiddenAmong(imports)).toEqual([]);
    expect(imports).toEqual(['node:crypto', 'node:fs', 'node:path']);
  });

  it('client-hook-command loads exactly the two narrow subpaths', () => {
    const imports = runtimeImportsOf(hookCommandPath);

    expect(forbiddenAmong(imports)).toEqual([]);
    expect(imports).toEqual(['@makaio/inbound-hooks/stdio', '@makaio/subsystem-client/hook-subjects']);
  });

  it.each([
    ['hook-fast-path', fastPathPath],
    ['builtin-hook-debounce', builtinDebouncePath],
    ['warning-debounce', warningDebouncePath],
    ['client-hook-command', hookCommandPath],
  ])('%s has no dynamic import() call', (_name, filePath) => {
    expect(hasDynamicImportCall(readFileSync(filePath, 'utf8'), filePath)).toBe(false);
  });

  it('exposes the light entrypoints in the package export maps', () => {
    expect(readManifest(join(cliRoot, 'package.json')).exports).toMatchObject({
      './hook-fast-path-detect': expect.any(String),
      './hook-fast-path': expect.any(String),
    });
    expect(readManifest(join(clientHooksRoot, 'package.json')).exports).toMatchObject({
      './hook-runner': expect.any(String),
    });
  });
});
