import { describe, expect, it } from 'bun:test';
import { createPortablePackageJson } from '../portable-package.js';

describe('portable package helper', () => {
  it('moves framework workspace dependencies to dev and adds @makaio/framework peer', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-openai-node',
        version: '0.1.0',
        private: true,
        dependencies: {
          '@makaio/bus-core': 'workspace:*',
          '@makaio/contracts': 'workspace:*',
          openai: '^4.0.0',
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.private).toBe(false);
    expect(result.dependencies).toEqual({ openai: '^4.0.0' });
    expect(result.devDependencies).toEqual({
      '@makaio/bus-core': 'workspace:*',
      '@makaio/contracts': 'workspace:*',
    });
    expect(result.peerDependencies).toEqual({ '@makaio/framework': '^0.1.0' });
  });

  it('keeps upstream SDK peers unchanged', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-openai-node',
        version: '0.1.0',
        peerDependencies: { openai: '^4.0.0' },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.peerDependencies).toEqual({
      openai: '^4.0.0',
      '@makaio/framework': '^0.1.0',
    });
  });

  it('moves internal workspace packages to dev dependencies', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-openai-node',
        version: '0.1.0',
        dependencies: {
          '@makaio/provider-openai': 'workspace:*',
          '@makaio/bus-core': 'workspace:*',
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.dependencies ?? {}).toEqual({});
    expect(result.devDependencies).toEqual({
      '@makaio/provider-openai': 'workspace:*',
      '@makaio/bus-core': 'workspace:*',
    });
  });

  it('moves explicitly framework-owned workspace packages to dev dependencies', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-test',
        version: '0.1.0',
        dependencies: {
          '@vendor/framework-runtime': 'workspace:*',
          '@vendor/sdk': '^1.0.0',
        },
      },
      { frameworkVersion: '0.1.0', frameworkOwnedPackages: ['@vendor/framework-runtime'] },
    );

    expect(result.dependencies).toEqual({ '@vendor/sdk': '^1.0.0' });
    expect(result.devDependencies).toEqual({ '@vendor/framework-runtime': 'workspace:*' });
  });

  it('removes private for publishable package output', () => {
    const result = createPortablePackageJson(
      { name: '@makaio/adapter-test', version: '0.1.0', private: true },
      { frameworkVersion: '0.1.0' },
    );
    expect(result.private).toBe(false);
  });

  it('supports custom framework peer range', () => {
    const result = createPortablePackageJson(
      { name: '@makaio/adapter-test', version: '0.1.0' },
      { frameworkVersion: '0.1.0', frameworkPeerRange: '>=0.1.0' },
    );
    expect(result.peerDependencies?.['@makaio/framework']).toBe('>=0.1.0');
  });

  it('points published entrypoints only at dist output', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-test',
        version: '0.1.0',
        main: 'src/index.ts',
        types: 'src/index.ts',
        exports: { '.': { source: './src/index.ts', types: './src/index.ts', default: './src/index.ts' } },
        publishConfig: {
          exports: {
            '.': './dist/index.js',
            './package.json': './package.json',
          },
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.main).toBe('dist/index.js');
    expect(result.types).toBe('dist/index.d.ts');
    expect(result.exports).toEqual({
      '.': {
        types: './dist/index.d.ts',
        default: './dist/index.js',
      },
      './package.json': './package.json',
    });
  });

  it('derives portable entrypoints from publish root export when non-index', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-custom-entry',
        version: '0.1.0',
        publishConfig: {
          exports: {
            '.': './dist/custom-entry.js',
          },
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.main).toBe('dist/custom-entry.js');
    expect(result.types).toBe('dist/custom-entry.d.ts');
  });

  it('derives declaration entrypoints for mjs and cjs publish exports', () => {
    const esmResult = createPortablePackageJson(
      {
        name: '@makaio/adapter-esm-entry',
        version: '0.1.0',
        publishConfig: { exports: { '.': './dist/index.mjs' } },
      },
      { frameworkVersion: '0.1.0' },
    );
    const cjsResult = createPortablePackageJson(
      {
        name: '@makaio/adapter-cjs-entry',
        version: '0.1.0',
        publishConfig: { exports: { '.': './dist/index.cjs' } },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(esmResult.types).toBe('dist/index.d.mts');
    expect(esmResult.exports).toMatchObject({ '.': { types: './dist/index.d.mts' } });
    expect(cjsResult.types).toBe('dist/index.d.cts');
    expect(cjsResult.exports).toMatchObject({ '.': { types: './dist/index.d.cts' } });
  });

  it('derives main/types from object-style root export in publishConfig without source conditions', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-conditional-entry',
        version: '0.1.0',
        exports: {
          '.': {
            source: './src/conditional-entry.ts',
            types: './src/conditional-entry.ts',
            default: './src/conditional-entry.ts',
          },
        },
        publishConfig: {
          exports: {
            '.': {
              default: './dist/conditional-entry.js',
              types: './dist/conditional-entry.d.ts',
            },
          },
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.main).toBe('dist/conditional-entry.js');
    expect(result.types).toBe('dist/conditional-entry.d.ts');
    expect(result.exports).toEqual({
      '.': {
        types: './dist/conditional-entry.d.ts',
        default: './dist/conditional-entry.js',
      },
    });
  });

  it('preserves object-style publish exports without inventing types', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/extension-client-hooks',
        version: '0.1.0',
        exports: {
          '.': './src/index.ts',
          './cli': './src/cli/index.ts',
        },
        publishConfig: {
          exports: {
            '.': { default: './dist/index.mjs' },
            './cli': { default: './dist/cli/index.mjs' },
          },
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.exports).toEqual({
      '.': {
        default: './dist/index.mjs',
      },
      './cli': {
        default: './dist/cli/index.mjs',
      },
    });
  });

  it('does not invent root main and types for subpath-only packages', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/extension-prompt',
        version: '0.1.0',
        exports: {
          './cli': './src/cli.ts',
          './package.json': './package.json',
        },
        publishConfig: {
          exports: {
            './cli': { default: './dist/cli.mjs' },
            './package.json': './package.json',
          },
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.main).toBeUndefined();
    expect(result.types).toBeUndefined();
    expect(result.exports).toEqual({
      './cli': {
        default: './dist/cli.mjs',
      },
      './package.json': './package.json',
    });
  });

  it('does not synthesize root exports when publishConfig omits exports for a subpath-only package', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/extension-subpath-only',
        version: '0.1.0',
        exports: {
          './cli': './src/cli.ts',
          './package.json': './package.json',
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.main).toBeUndefined();
    expect(result.types).toBeUndefined();
    expect(result.exports).toEqual({
      './package.json': './package.json',
    });
  });

  it('aligns fallback exports with publishConfig main and types without source conditions', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-custom-entry',
        version: '0.1.0',
        exports: {
          '.': {
            source: './src/custom-entry.ts',
            types: './src/custom-entry.ts',
            default: './src/custom-entry.ts',
          },
          './package.json': './package.json',
        },
        publishConfig: {
          main: 'dist/custom-entry.js',
          types: 'dist/custom-entry.d.ts',
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.main).toBe('dist/custom-entry.js');
    expect(result.types).toBe('dist/custom-entry.d.ts');
    expect(result.exports).toEqual({
      '.': {
        types: './dist/custom-entry.d.ts',
        default: './dist/custom-entry.js',
      },
      './package.json': './package.json',
    });
  });

  it('does not preserve source-only subpath exports in publish manifests', () => {
    const result = createPortablePackageJson(
      {
        name: '@makaio/adapter-custom-entry',
        version: '0.1.0',
        exports: {
          '.': {
            source: './src/custom-entry.ts',
            types: './src/custom-entry.ts',
            default: './src/custom-entry.ts',
          },
          './feature': {
            source: './src/feature.ts',
            types: './src/feature.ts',
            default: './src/feature.ts',
          },
          './package.json': './package.json',
        },
        publishConfig: {
          main: 'dist/custom-entry.js',
          types: 'dist/custom-entry.d.ts',
        },
      },
      { frameworkVersion: '0.1.0' },
    );

    expect(result.exports).toEqual({
      '.': {
        types: './dist/custom-entry.d.ts',
        default: './dist/custom-entry.js',
      },
      './package.json': './package.json',
    });
  });
});
