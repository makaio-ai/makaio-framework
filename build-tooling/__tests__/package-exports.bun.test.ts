import { describe, expect, it } from 'bun:test';
import {
  isBuildableSourceTarget,
  normalizePackageExports,
  resolvePackageExportSourceTarget,
} from '../package-exports.js';

describe('package export source resolution', () => {
  it('accepts direct TypeScript source exports', () => {
    expect(resolvePackageExportSourceTarget('./src/index.ts')).toBe('./src/index.ts');
    expect(resolvePackageExportSourceTarget('./src/widget.tsx')).toBe('./src/widget.tsx');
    expect(resolvePackageExportSourceTarget('./src/entry.mts')).toBe('./src/entry.mts');
  });

  it('resolves conditional source targets without requiring a default condition', () => {
    expect(
      resolvePackageExportSourceTarget({
        import: './src/index.ts',
        types: './src/index.ts',
      }),
    ).toBe('./src/index.ts');
  });

  it('resolves CommonJS TypeScript source conditions', () => {
    expect(
      resolvePackageExportSourceTarget({
        require: './src/index.cts',
      }),
    ).toBe('./src/index.cts');
  });

  it('prefers source-like conditions over dist declaration targets', () => {
    expect(
      resolvePackageExportSourceTarget({
        default: './dist/index.mjs',
        types: './dist/index.d.mts',
        source: './src/index.ts',
      }),
    ).toBe('./src/index.ts');
  });

  it('rejects non-source targets', () => {
    expect(resolvePackageExportSourceTarget('./dist/index.mjs')).toBeUndefined();
    expect(resolvePackageExportSourceTarget('./dist/index.d.mts')).toBeUndefined();
    expect(resolvePackageExportSourceTarget('./src/style.css')).toBeUndefined();
  });

  it('classifies TypeScript declaration files as non-buildable', () => {
    expect(isBuildableSourceTarget('./src/index.ts')).toBe(true);
    expect(isBuildableSourceTarget('./dist/index.d.ts')).toBe(false);
    expect(isBuildableSourceTarget('./dist/index.d.mts')).toBe(false);
  });

  it('normalizes root string shorthand exports', () => {
    expect(normalizePackageExports('./src/index.ts')).toEqual({ '.': './src/index.ts' });
  });

  it('normalizes root conditional exports', () => {
    expect(normalizePackageExports({ import: './src/index.ts', types: './src/index.ts' })).toEqual({
      '.': { import: './src/index.ts', types: './src/index.ts' },
    });
  });

  it('rejects array values in root conditional exports', () => {
    expect(() => normalizePackageExports({ import: ['./src/index.ts'] })).toThrow(
      'Unsupported package export value for root condition "import".',
    );
  });

  it('rejects nested objects in root conditional exports', () => {
    expect(() => normalizePackageExports({ import: { default: './src/index.ts' } })).toThrow(
      'Unsupported package export value for root condition "import".',
    );
  });

  it('preserves subpath export maps', () => {
    expect(normalizePackageExports({ '.': './src/index.ts', './feature': './src/feature.ts' })).toEqual({
      '.': './src/index.ts',
      './feature': './src/feature.ts',
    });
  });

  it('preserves subpath conditional exports', () => {
    expect(
      normalizePackageExports({
        './feature': { import: './src/feature.ts', types: './src/feature.ts' },
      }),
    ).toEqual({
      './feature': { import: './src/feature.ts', types: './src/feature.ts' },
    });
  });

  it('rejects array values in subpath conditional exports', () => {
    expect(() => normalizePackageExports({ './feature': { import: ['./src/feature.ts'] } })).toThrow(
      'Unsupported package export value for "./feature" condition "import".',
    );
  });

  it('rejects nested objects in subpath conditional exports', () => {
    expect(() => normalizePackageExports({ './feature': { import: { default: './src/feature.ts' } } })).toThrow(
      'Unsupported package export value for "./feature" condition "import".',
    );
  });

  it('rejects mixed subpath and root condition keys', () => {
    expect(() => normalizePackageExports({ '.': './src/index.ts', import: './src/index.ts' })).toThrow(
      'Package exports cannot mix subpath keys with root condition keys.',
    );
  });
});
