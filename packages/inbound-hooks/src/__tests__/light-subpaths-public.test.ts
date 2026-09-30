/**
 * Boundary tests for the light `@makaio/inbound-hooks` subpaths (`./stdio`,
 * `./fast-connection`).
 *
 * Hook subprocesses load these entrypoints on every native hook event, so they
 * must not evaluate the package index or any heavier module than the ones
 * allowed here. `fast-hook-timing` is an internal helper and stays unexposed.
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

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const frameworkRoot = dirname(dirname(packageRoot));
const frameworkPackageRoot = join(frameworkRoot, 'packages', 'framework');

interface PackageManifest {
  readonly exports?: Record<string, unknown>;
  readonly publishConfig?: { readonly exports?: Record<string, unknown> };
}

/**
 * Read a package manifest from its directory.
 * @param root - Directory containing the `package.json`.
 * @returns Parsed manifest.
 */
function readPackageManifest(root: string): PackageManifest {
  return readManifest(join(root, 'package.json')) as PackageManifest;
}

/**
 * Read a source file of this package.
 * @param name - File name below `src/`.
 * @returns Source text.
 */
function readSource(name: string): string {
  return readFileSync(join(packageRoot, 'src', name), 'utf8');
}

describe('@makaio/inbound-hooks light subpaths', () => {
  it('stdio loads only node:stream/consumers at runtime', () => {
    expect(collectRuntimeImports(readSource('stdio.ts'), 'stdio.ts')).toEqual(['node:stream/consumers']);
  });

  it('fast-connection loads only the bus core, websocket transport, and timing helper at runtime', () => {
    // `@makaio/bus-core` is imported via its root barrel, which transitively loads the
    // contracts barrel today; accepted until FACT-392.
    expect(collectRuntimeImports(readSource('fast-connection.ts'), 'fast-connection.ts')).toEqual([
      './fast-hook-timing.js',
      '@makaio/bus-core',
      '@makaio/bus-transport-websocket',
    ]);
  });

  it('fast-hook-timing loads no runtime module', () => {
    expect(collectRuntimeImports(readSource('fast-hook-timing.ts'), 'fast-hook-timing.ts')).toEqual([]);
  });

  it('stdio, fast-connection, and fast-hook-timing contain no dynamic import() calls', () => {
    for (const name of ['stdio.ts', 'fast-connection.ts', 'fast-hook-timing.ts']) {
      expect(hasDynamicImportCall(readSource(name), name)).toBe(false);
    }
  });

  it('fast-connection exports only DEFAULT_FAST_HOOK_BUS_URL and connectFastHookBus as values', async () => {
    expect(Object.keys(await import('../fast-connection.js')).sort()).toEqual([
      'DEFAULT_FAST_HOOK_BUS_URL',
      'connectFastHookBus',
    ]);
  });

  it('exposes both subpaths in the workspace, publish, and umbrella export maps', () => {
    const manifest = readPackageManifest(packageRoot);

    expect(manifest.exports).toMatchObject({
      './stdio': './src/stdio.ts',
      './fast-connection': './src/fast-connection.ts',
    });
    expect(manifest.publishConfig?.exports).toMatchObject({
      './stdio': './dist/stdio.mjs',
      './fast-connection': './dist/fast-connection.mjs',
    });
    expect(readPackageManifest(frameworkPackageRoot).exports).toMatchObject({
      './inbound-hooks/stdio': {
        types: './dist/inbound-hooks/stdio.d.mts',
        default: './dist/inbound-hooks/stdio.mjs',
      },
      './inbound-hooks/fast-connection': {
        types: './dist/inbound-hooks/fast-connection.d.mts',
        default: './dist/inbound-hooks/fast-connection.mjs',
      },
    });
  });

  it('keeps fast-hook-timing internal', () => {
    const manifest = readPackageManifest(packageRoot);
    const umbrella = readPackageManifest(frameworkPackageRoot);

    for (const map of [manifest.exports, manifest.publishConfig?.exports, umbrella.exports]) {
      expect(Object.keys(map ?? {}).filter((key) => key.includes('fast-hook-timing'))).toEqual([]);
    }
  });

  it('builds both subpaths as tsdown entries and not the timing helper', () => {
    const config = readFileSync(join(packageRoot, 'tsdown.config.ts'), 'utf8');

    expect(config).toContain("stdio: './src/stdio.ts'");
    expect(config).toContain("'fast-connection': './src/fast-connection.ts'");
    expect(config).not.toContain('fast-hook-timing');
  });
});
