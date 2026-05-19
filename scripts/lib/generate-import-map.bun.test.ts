import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { SHARED_BROWSER_EXTERNALS } from '../../build-tooling/browser-shared-externals.js';
import { generateImportMap, generateImportMapFromBundle, type OutputBundleLike } from './generate-import-map.js';

describe('generateImportMap', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    // Restore any console spies that survived (e.g., after a test failure).
    mock.restore();
  });

  it('matches a later valid dependency occurrence when an earlier substring is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-map-'));
    tempDirs.push(dir);

    const manifestPath = join(dir, 'manifest.json');
    const outputPath = join(dir, 'import-map.json');

    // The key 'assets/react-dom/node_modules/react/index.js' contains 'react'
    // twice: once inside 'react-dom' (invalid left boundary - preceded by 's')
    // and once as 'react/index.js' (valid left boundary '/').
    // Verify that only the valid occurrence at the right boundary is accepted.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        'assets/react-dom/node_modules/react/index.js': {
          file: 'assets/react.js',
        },
        'assets/react-dom/index.js': {
          file: 'assets/react-dom.js',
        },
        'assets/node_modules/@makaio/ui-kernel/index.js': {
          file: 'assets/ui-kernel.js',
        },
      }),
    );

    generateImportMap(manifestPath, outputPath, '/static');

    const importMap = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      imports: Record<string, string | undefined>;
    };

    expect(importMap.imports.react).toBe('/static/assets/react.js');
  });

  it('resolves the canonical shared browser externals from a realistic manifest in deterministic order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-map-'));
    tempDirs.push(dir);

    const manifestPath = join(dir, 'manifest.json');
    const outputPath = join(dir, 'import-map.json');

    // Keys must satisfy matchesDep's boundary rules:
    //   - 'react': left=/ right=/ -> node_modules/react/index.js
    //   - 'react-dom': left=/ right=/ -> node_modules/react-dom/index.js
    //   - 'react/jsx-runtime': left=/ right=/ -> node_modules/react/jsx-runtime/index.js
    //   - '@makaio/ui-kernel': left=/ right=/ -> node_modules/@makaio/ui-kernel/index.js
    //
    // 'react/jsx-runtime' CANNOT use a key ending in 'jsx-runtime.js' because '.'
    // is not a recognised right-boundary character in matchesDep; it must use a
    // directory-style key ending in '/index.js' so the dep ends at a '/' boundary.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        'node_modules/react/index.js': {
          file: 'assets/react-abc123.js',
        },
        'node_modules/react-dom/index.js': {
          file: 'assets/react-dom-abc123.js',
        },
        'node_modules/react/jsx-runtime/index.js': {
          file: 'assets/react-jsx-runtime-abc123.js',
        },
        'node_modules/@makaio/ui-kernel/index.js': {
          file: 'assets/ui-kernel-abc123.js',
        },
        'node_modules/@makaio/ui-hooks/index.js': {
          file: 'assets/ui-hooks-abc123.js',
        },
        'node_modules/@makaio/ui-components/index.js': {
          file: 'assets/ui-components-abc123.js',
        },
        'node_modules/@makaio/ui-views/index.js': {
          file: 'assets/ui-views-abc123.js',
        },
      }),
    );

    generateImportMap(manifestPath, outputPath, '/static');

    const importMap = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      imports: Record<string, string | undefined>;
    };

    expect(importMap.imports['react']).toBe('/static/assets/react-abc123.js');
    expect(importMap.imports['react-dom']).toBe('/static/assets/react-dom-abc123.js');
    expect(importMap.imports['react/jsx-runtime']).toBe('/static/assets/react-jsx-runtime-abc123.js');
    expect(importMap.imports['@makaio/ui-kernel']).toBe('/static/assets/ui-kernel-abc123.js');
    expect(importMap.imports['@makaio/ui-hooks']).toBe('/static/assets/ui-hooks-abc123.js');
    expect(importMap.imports['@makaio/ui-components']).toBe('/static/assets/ui-components-abc123.js');
    expect(importMap.imports['@makaio/ui-views']).toBe('/static/assets/ui-views-abc123.js');
    expect(Object.keys(importMap.imports)).toEqual([...SHARED_BROWSER_EXTERNALS]);
  });

  it('logs a warning for each dependency missing from the manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-map-'));
    tempDirs.push(dir);

    const manifestPath = join(dir, 'manifest.json');
    const outputPath = join(dir, 'import-map.json');

    // Manifest contains every dep except react-dom.
    // Keys satisfy matchesDep boundary rules (see "resolves all SHARED_DEPS" test).
    writeFileSync(
      manifestPath,
      JSON.stringify({
        'node_modules/react/index.js': {
          file: 'assets/react-abc123.js',
        },
        'node_modules/react/jsx-runtime/index.js': {
          file: 'assets/react-jsx-runtime-abc123.js',
        },
        'node_modules/@makaio/ui-kernel/index.js': {
          file: 'assets/ui-kernel-abc123.js',
        },
      }),
    );

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);

    generateImportMap(manifestPath, outputPath, '/static');

    // Assert before restoring - mockRestore() clears call history.
    expect(warnSpy).toHaveBeenCalledTimes(SHARED_BROWSER_EXTERNALS.length - 3);
    expect(warnSpy.mock.calls[0][0]).toContain('react-dom');
  });

  it('does not match react to a preact-only manifest entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-map-'));
    tempDirs.push(dir);

    const manifestPath = join(dir, 'manifest.json');
    const outputPath = join(dir, 'import-map.json');

    // Only preact present - no canonical shared browser external.
    writeFileSync(
      manifestPath,
      JSON.stringify({
        'node_modules/preact/index.js': {
          file: 'assets/preact-abc123.js',
        },
      }),
    );

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);

    generateImportMap(manifestPath, outputPath, '/static');

    const importMap = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      imports: Record<string, string | undefined>;
    };

    // preact must NOT be resolved as react.
    expect(importMap.imports['react']).toBeUndefined();
    // A warning must have been emitted for the unresolved react dep.
    // Assert before restoring - mockRestore() clears call history.
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnMessages.some((msg) => msg.includes('"react"'))).toBe(true);
  });

  it('produces correct URLs when basePath has no trailing slash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'import-map-'));
    tempDirs.push(dir);

    const manifestPath = join(dir, 'manifest.json');
    const outputPath = join(dir, 'import-map.json');

    writeFileSync(
      manifestPath,
      JSON.stringify({
        'node_modules/react/index.js': {
          file: 'react-chunk.js',
        },
        'node_modules/react-dom/index.js': {
          file: 'react-dom-chunk.js',
        },
        'node_modules/react/jsx-runtime/index.js': {
          file: 'react-jsx-runtime-chunk.js',
        },
        'node_modules/@makaio/ui-kernel/index.js': {
          file: 'ui-kernel-chunk.js',
        },
        'node_modules/@makaio/ui-hooks/index.js': {
          file: 'ui-hooks-chunk.js',
        },
        'node_modules/@makaio/ui-components/index.js': {
          file: 'ui-components-chunk.js',
        },
        'node_modules/@makaio/ui-views/index.js': {
          file: 'ui-views-chunk.js',
        },
      }),
    );

    generateImportMap(manifestPath, outputPath, '/assets');

    const importMap = JSON.parse(readFileSync(outputPath, 'utf-8')) as {
      imports: Record<string, string | undefined>;
    };

    // Every URL must start with exactly '/assets/' - not '/assetsfile.js'.
    for (const url of Object.values(importMap.imports)) {
      expect(url).toMatch(/^\/assets\//);
    }
  });
});

describe('generateImportMapFromBundle', () => {
  /**
   * Build a minimal OutputBundleLike chunk entry for testing.
   * @param fileName - Output file name (e.g. `assets/react-abc.js`).
   * @param facadeModuleId - Source module ID, or null for synthetic chunks.
   * @returns Chunk entry conforming to `OutputBundleLike`.
   */
  function makeChunk(fileName: string, facadeModuleId: string | null): OutputBundleLike[string] {
    return { type: 'chunk', fileName, facadeModuleId };
  }

  it('resolves a react chunk by facadeModuleId', () => {
    const bundle: OutputBundleLike = {
      'assets/react-abc123.js': makeChunk('assets/react-abc123.js', '/root/node_modules/react/index.js'),
    };

    const { imports } = generateImportMapFromBundle(bundle, '/');

    expect(imports['react']).toBe('/assets/react-abc123.js');
  });

  it('resolves the canonical shared browser externals from a realistic bundle in deterministic order', () => {
    const bundle: OutputBundleLike = {
      'assets/react-abc.js': makeChunk('assets/react-abc.js', '/root/node_modules/react/index.js'),
      'assets/react-dom-abc.js': makeChunk('assets/react-dom-abc.js', '/root/node_modules/react-dom/index.js'),
      'assets/jsx-runtime-abc.js': makeChunk(
        'assets/jsx-runtime-abc.js',
        '/root/node_modules/react/jsx-runtime/index.js',
      ),
      'assets/ui-kernel-abc.js': makeChunk('assets/ui-kernel-abc.js', '/root/node_modules/@makaio/ui-kernel/index.js'),
      'assets/ui-hooks-abc.js': makeChunk('assets/ui-hooks-abc.js', '/root/node_modules/@makaio/ui-hooks/index.js'),
      'assets/ui-components-abc.js': makeChunk(
        'assets/ui-components-abc.js',
        '/root/node_modules/@makaio/ui-components/index.js',
      ),
      'assets/ui-views-abc.js': makeChunk('assets/ui-views-abc.js', '/root/node_modules/@makaio/ui-views/index.js'),
    };

    const { imports } = generateImportMapFromBundle(bundle, '/');

    expect(imports['react']).toBe('/assets/react-abc.js');
    expect(imports['react-dom']).toBe('/assets/react-dom-abc.js');
    expect(imports['react/jsx-runtime']).toBe('/assets/jsx-runtime-abc.js');
    expect(imports['@makaio/ui-kernel']).toBe('/assets/ui-kernel-abc.js');
    expect(imports['@makaio/ui-hooks']).toBe('/assets/ui-hooks-abc.js');
    expect(imports['@makaio/ui-components']).toBe('/assets/ui-components-abc.js');
    expect(imports['@makaio/ui-views']).toBe('/assets/ui-views-abc.js');
    expect(Object.keys(imports)).toEqual([...SHARED_BROWSER_EXTERNALS]);
  });

  it('returns empty imports for an empty bundle', () => {
    const { imports } = generateImportMapFromBundle({}, '/');
    expect(imports).toEqual({});
  });

  it('skips assets (type !== chunk)', () => {
    const bundle: OutputBundleLike = {
      'assets/style.css': { type: 'asset' },
    };

    const { imports } = generateImportMapFromBundle(bundle, '/');
    expect(imports).toEqual({});
  });

  it('skips chunks with null facadeModuleId', () => {
    const bundle: OutputBundleLike = {
      'assets/vendor.js': makeChunk('assets/vendor.js', null),
    };

    const { imports } = generateImportMapFromBundle(bundle, '/');
    expect(imports).toEqual({});
  });

  it('resolves generated shared facade entries by stable file prefix', () => {
    const bundle: OutputBundleLike = {
      'assets/__makaio_shared_react_jsx_runtime-abc.js': makeChunk(
        'assets/__makaio_shared_react_jsx_runtime-abc.js',
        null,
      ),
      'assets/__makaio_shared_makaio_ui_kernel-def.js': makeChunk(
        'assets/__makaio_shared_makaio_ui_kernel-def.js',
        null,
      ),
    };

    const { imports } = generateImportMapFromBundle(bundle, '/');

    expect(imports['react/jsx-runtime']).toBe('/assets/__makaio_shared_react_jsx_runtime-abc.js');
    expect(imports['@makaio/ui-kernel']).toBe('/assets/__makaio_shared_makaio_ui_kernel-def.js');
  });

  it('does not resolve react from the react-dom generated shared facade', () => {
    const bundle: OutputBundleLike = {
      'assets/__makaio_shared_react-CXXQTQN8.js': makeChunk('assets/__makaio_shared_react-CXXQTQN8.js', null),
      'assets/__makaio_shared_react_dom-CFSFKztH.js': makeChunk('assets/__makaio_shared_react_dom-CFSFKztH.js', null),
    };

    const { imports } = generateImportMapFromBundle(bundle, '/');

    expect(imports['react']).toBe('/assets/__makaio_shared_react-CXXQTQN8.js');
    expect(imports['react-dom']).toBe('/assets/__makaio_shared_react_dom-CFSFKztH.js');
  });

  it('prefers the shortest matching candidate within a chunk', () => {
    const bundle: OutputBundleLike = {
      'assets/vendor.js': {
        type: 'chunk',
        fileName: 'assets/vendor.js',
        facadeModuleId: '/root/node_modules/react/index.js',
        moduleIds: ['react'],
      },
      'assets/react.js': makeChunk('assets/react.js', '/root/node_modules/react/index.js'),
    };

    const { imports } = generateImportMapFromBundle(bundle, '/');

    expect(imports['react']).toBe('/assets/vendor.js');
  });

  it('uses default basePath "/" when not provided', () => {
    const bundle: OutputBundleLike = {
      'assets/react-abc.js': makeChunk('assets/react-abc.js', '/root/node_modules/react/index.js'),
    };

    const { imports } = generateImportMapFromBundle(bundle);

    expect(imports['react']).toBe('/assets/react-abc.js');
  });

  it('prepends basePath without double slash', () => {
    const bundle: OutputBundleLike = {
      'assets/react-abc.js': makeChunk('assets/react-abc.js', '/root/node_modules/react/index.js'),
    };

    const { imports } = generateImportMapFromBundle(bundle, '/static');

    expect(imports['react']).toBe('/static/assets/react-abc.js');
  });
});
