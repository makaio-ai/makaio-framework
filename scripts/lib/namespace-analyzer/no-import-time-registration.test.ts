import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../../../', import.meta.url).pathname;

const allowedFiles = new Set([
  'framework/adapters/core/src/factory/create-adapter-namespace.ts',
  'framework/packages/bus-core/src/bus.ts',
  'framework/packages/bus-core/src/channel/channel-endpoint.ts',
  'framework/packages/clients-core/src/create-client-namespace.ts',
  'framework/packages/storage/core/src/create-storage-namespace.ts',
]);

const extensionFactoryFiles = {
  createExtensionNamespace: 'framework/packages/bus-core/src/create-extension-namespace.ts',
  createExtensionStorageNamespace: 'framework/packages/storage/core/src/create-extension-storage-namespace.ts',
} as const;
const extensionFactoryNames = ['createExtensionNamespace', 'createExtensionStorageNamespace'] as const;

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (fullPath.includes('/node_modules/') || fullPath.includes('/dist/') || fullPath.includes('/__tests__/')) {
      return [];
    }
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return listSourceFiles(fullPath);
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) return [];
    return [fullPath];
  });
}

describe('namespace registration side effects', () => {
  it('does not register static namespaces at module import time', () => {
    const roots = ['framework', 'product'].map((dir) => join(repoRoot, dir));
    const sideEffectfulExtensionFactories = getSideEffectfulExtensionFactories();
    const violations = roots
      .flatMap(listSourceFiles)
      .map((file) => ({ file, source: stripComments(readFileSync(file, 'utf8')) }))
      .filter(({ file }) => !allowedFiles.has(relative(repoRoot, file)))
      .filter(({ source }) => {
        return (
          /MakaioBus\.registerNamespace\s*\(\s*createBusNamespace/.test(source) ||
          /MakaioBus\.registerNamespace\s*\(\s*createStorageNamespace/.test(source) ||
          /createStorageNamespace\s*\(/.test(source) ||
          (sideEffectfulExtensionFactories.has('createExtensionNamespace') &&
            /createExtensionNamespace\s*\(/.test(source)) ||
          (sideEffectfulExtensionFactories.has('createExtensionStorageNamespace') &&
            /createExtensionStorageNamespace\s*\(/.test(source))
        );
      })
      .map(({ file }) => relative(repoRoot, file));

    expect(violations).toEqual([]);
  });

  it('does not expose side-effect-only register entrypoints for namespace registration', () => {
    // Pure re-export barrels that happen to use "register" in their subpath
    // for domain reasons (e.g., "register CLI commands"), not namespace side-effects.
    const allowedRegisterExports = new Set(['./kernel/cli/register']);
    const packageFiles = ['framework', 'product'].map((dir) => join(repoRoot, dir)).flatMap(listPackageFiles);

    const violations = packageFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      const pkg = JSON.parse(source) as {
        exports?: Record<string, unknown>;
        publishConfig?: { exports?: Record<string, unknown> };
        sideEffects?: unknown;
      };
      const exportKeys = [...Object.keys(pkg.exports ?? {}), ...Object.keys(pkg.publishConfig?.exports ?? {})].filter(
        (key) => (key === './register' || key.endsWith('/register')) && !allowedRegisterExports.has(key),
      );
      const sideEffects =
        Array.isArray(pkg.sideEffects) && pkg.sideEffects.some((entry) => String(entry).includes('namespace'));

      return exportKeys.length > 0 || sideEffects ? [relative(repoRoot, file)] : [];
    });

    expect(violations).toEqual([]);
  });
});

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function getSideEffectfulExtensionFactories(): Set<keyof typeof extensionFactoryFiles> {
  const sideEffectfulFactories = new Set<keyof typeof extensionFactoryFiles>();

  for (const factoryName of extensionFactoryNames) {
    const file = extensionFactoryFiles[factoryName];
    const source = stripComments(readFileSync(join(repoRoot, file), 'utf8'));
    if (/MakaioBus\.registerNamespace\s*\(/.test(source) || /createStorageNamespace\s*\(/.test(source)) {
      sideEffectfulFactories.add(factoryName);
    }
  }

  return sideEffectfulFactories;
}

function listPackageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    if (fullPath.includes('/node_modules/') || fullPath.includes('/dist/')) return [];
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return listPackageFiles(fullPath);
    return entry === 'package.json' ? [fullPath] : [];
  });
}
