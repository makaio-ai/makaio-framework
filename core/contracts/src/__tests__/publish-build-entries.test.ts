import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  normalizePackageExports,
  resolvePackageExportSourceTarget,
  type PackageExportValue,
  type PackageExportsField,
} from '@makaio/build-tooling/package-exports';

interface ContractsManifest {
  readonly exports?: PackageExportsField;
  readonly publishConfig?: {
    readonly exports?: PackageExportsField;
  };
}

const packageRoot = resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as ContractsManifest;
const {
  default: tsdownConfig,
  resolvePublishBuildEntries,
  resolvePublishEntryName,
} = (await import('../../tsdown.config.js')) as {
  default: { readonly entry?: Record<string, string> };
  resolvePublishBuildEntries: (manifest: ContractsManifest, packageDirectory: string) => Record<string, string>;
  resolvePublishEntryName: (exportKey: string, publishExport: PackageExportValue | undefined) => string;
};

describe('@makaio/contracts publish build entries', () => {
  it('maps every public source export to its declared published runtime alias', () => {
    const sourceExports = normalizePackageExports(manifest.exports);
    const publishExports = normalizePackageExports(manifest.publishConfig?.exports);
    const entries = tsdownConfig.entry ?? {};

    expect(Object.keys(publishExports).sort()).toEqual(Object.keys(sourceExports).sort());

    for (const [exportKey, sourceExport] of Object.entries(sourceExports)) {
      if (exportKey === './package.json') continue;

      const sourceTarget = resolvePackageExportSourceTarget(sourceExport);
      expect(sourceTarget, `${exportKey} must have a buildable source target`).toBeDefined();
      if (!sourceTarget) {
        throw new Error(`${exportKey} must have a buildable source target`);
      }
      expect(existsSync(resolve(packageRoot, sourceTarget)), `${exportKey} source must exist`).toBe(true);

      const publishExport = publishExports[exportKey];
      const entryName = resolvePublishEntryName(exportKey, publishExport);
      expect(entries[entryName], `${exportKey} must retain its published runtime alias`).toBe(sourceTarget);
    }
  });

  it('keeps the reaction subpath aligned with its published entrypoint', () => {
    expect(tsdownConfig.entry).toMatchObject({
      'reaction/index': './src/reaction/index.ts',
    });
  });

  it('keeps the automation-trigger subpath aligned with its published entrypoint', () => {
    expect(tsdownConfig.entry).toMatchObject({
      'automation-trigger/index': './src/automation-trigger/index.ts',
    });
  });

  it.each([
    './dist/../escape.mjs',
    './dist/nested/../../escape.mjs',
    './dist/./reaction.mjs',
    './dist/reaction//index.mjs',
    './dist/reaction\\index.mjs',
    './dist/%2e%2e/escape.mjs',
    './dist/%2E%2E/escape.mjs',
    './dist/reaction%2findex.mjs',
    './dist/reaction%5Cindex.mjs',
    './dist/.mjs',
  ])('rejects a published runtime target outside the normalized dist subtree: %s', (runtimeTarget) => {
    expect(() => resolvePublishEntryName('./reaction', { default: runtimeTarget })).toThrow(
      '@makaio/contracts export "./reaction" has an invalid published runtime path',
    );
  });

  it.each([
    {
      name: 'an export without a buildable source target',
      fixture: {
        exports: { './broken': './package.json' },
        publishConfig: { exports: { './broken': { default: './dist/broken.mjs' } } },
      },
      message: 'export "./broken" has no buildable source target',
    },
    {
      name: 'an export whose source file is missing',
      fixture: {
        exports: { './missing': './src/missing.ts' },
        publishConfig: { exports: { './missing': { default: './dist/missing.mjs' } } },
      },
      message: 'export "./missing" has no buildable source file: ./src/missing.ts',
    },
    {
      name: 'two exports with the same published entry name',
      fixture: {
        exports: { './first': './src/index.ts', './second': './src/index.ts' },
        publishConfig: {
          exports: {
            './first': { default: './dist/shared.mjs' },
            './second': { default: './dist/shared.mjs' },
          },
        },
      },
      message: 'export "./second" duplicates build entry "shared"',
    },
    {
      name: 'a published export without a source export',
      fixture: {
        exports: { '.': './src/index.ts' },
        publishConfig: {
          exports: {
            '.': { default: './dist/index.mjs' },
            './orphan': { default: './dist/orphan.mjs' },
          },
        },
      },
      message: 'published export "./orphan" has no matching source export',
    },
    {
      name: 'a manifest without buildable exports',
      fixture: {
        exports: { './package.json': './package.json' },
        publishConfig: { exports: { './package.json': './package.json' } },
      },
      message: 'has no buildable source exports',
    },
  ])('rejects $name', ({ fixture, message }) => {
    expect(() => resolvePublishBuildEntries(fixture, packageRoot)).toThrow(message);
  });
});
