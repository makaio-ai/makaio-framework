import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RuntimeNodePackageJson {
  readonly private?: boolean;
  readonly engines?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly files?: string[];
  readonly exports?: Record<string, unknown>;
  readonly peerDependencies?: Record<string, string>;
  readonly publishConfig?: {
    readonly access?: string;
    readonly directory?: string;
    readonly exports?: Record<string, unknown>;
  };
}

const packageJsonPath = resolve(import.meta.dirname, '..', '..', 'package.json');
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as RuntimeNodePackageJson;
const { default: tsdownConfig } = (await import('../../tsdown.config.js')) as {
  default: { readonly entry?: Record<string, string> };
};

describe('@makaio/runtime-node public package contract', () => {
  it('is publishable as the public Node runtime API', () => {
    expect(manifest.private).toBeUndefined();
    expect(manifest.engines?.['node']).toBe('>=22.15.0');
    expect(manifest.publishConfig?.access).toBe('public');
    expect(manifest.publishConfig?.directory).toBe('node_modules/.makaio-publish');
    expect(manifest.scripts?.build).toBe('bun build.ts');
  });

  it('publishes dist output and required metadata only', () => {
    expect(manifest.files).toEqual(['dist', 'LICENSE', 'README.md', 'package.json']);
  });

  it('has publish exports for every source export', () => {
    const sourceExportKeys = Object.keys(manifest.exports ?? {}).sort();
    const publishExportKeys = Object.keys(manifest.publishConfig?.exports ?? {}).sort();

    expect(publishExportKeys).toEqual(sourceExportKeys);
  });

  it('maps published runtime entrypoints to tsdown build entries', () => {
    const buildEntries = tsdownConfig.entry ?? {};
    const publishExports = manifest.publishConfig?.exports ?? {};

    for (const [subpath, target] of Object.entries(publishExports)) {
      if (subpath === './package.json') continue;
      expect(typeof target).toBe('object');
      expect(target).not.toBeNull();

      const defaultTarget = (target as { readonly default?: string }).default;
      expect(defaultTarget).toMatch(/^\.\/dist\/.+\.mjs$/);

      const distEntry = defaultTarget?.replace('./dist/', '').replace(/\.mjs$/, '');
      expect(buildEntries).toHaveProperty(distEntry ?? '');
    }
  });
});
