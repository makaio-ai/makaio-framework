import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const frameworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const allowedFiles = new Set([
  'adapters/core/src/factory/create-adapter-namespace.ts',
  'core/bus-core/src/bus.ts',
  'core/bus-core/src/channel/channel-endpoint.ts',
  'subsystems/client/src/create-client-namespace.ts',
  'storage/core/src/create-storage-namespace.ts',
]);

const extensionFactoryFiles = {
  createExtensionNamespace: 'core/bus-core/src/create-extension-namespace.ts',
  createExtensionStorageNamespace: 'storage/core/src/create-extension-storage-namespace.ts',
} as const;
const extensionFactoryNames = ['createExtensionNamespace', 'createExtensionStorageNamespace'] as const;
const sourceSkipDirs = new Set(['dist', 'node_modules', '__tests__']);
const packageSkipDirs = new Set(['dist', 'node_modules']);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && sourceSkipDirs.has(entry.name)) return [];

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(fullPath);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [fullPath];
  });
}

describe('namespace registration side effects', () => {
  it('does not register static namespaces at module import time', () => {
    const sideEffectfulExtensionFactories = getSideEffectfulExtensionFactories();
    const violations = listSourceFiles(frameworkRoot)
      .map((file) => ({ file, source: stripComments(readFileSync(file, 'utf8')) }))
      .filter(({ file }) => !allowedFiles.has(relative(frameworkRoot, file)))
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
      .map(({ file }) => relative(frameworkRoot, file));

    expect(violations).toEqual([]);
  });

  it('does not expose side-effect-only register entrypoints for namespace registration', () => {
    // Pure re-export barrels that happen to use "register" in their subpath
    // for domain reasons (e.g., "register CLI commands"), not namespace side-effects.
    // Allowances are scoped per package.json so no other package can adopt a
    // "/register" subpath unnoticed:
    // - packages/kernel `./cli/register` → src/cli/register.ts, a pure barrel
    //   re-exporting CliNamespace/CliRpcSubjects (createBusNamespace performs no
    //   bus registration at import time). The umbrella build derives its dist
    //   entries from this exports map (packages/framework/build.ts), so the key
    //   must exist here for the published `./kernel/cli/register` subpath.
    // - packages/framework `./kernel/cli/register` → the umbrella republication
    //   of that same kernel barrel.
    const allowedRegisterExports = new Map<string, ReadonlySet<string>>([
      ['packages/kernel/package.json', new Set(['./cli/register'])],
      ['packages/framework/package.json', new Set(['./kernel/cli/register'])],
    ]);
    const packageFiles = listPackageFiles(frameworkRoot);

    const violations = packageFiles.flatMap((file) => {
      const relPath = relative(frameworkRoot, file);
      const allowedKeys = allowedRegisterExports.get(relPath);
      const source = readFileSync(file, 'utf8');
      const pkg = JSON.parse(source) as {
        exports?: Record<string, unknown>;
        publishConfig?: { exports?: Record<string, unknown> };
        sideEffects?: unknown;
      };
      const exportKeys = [...Object.keys(pkg.exports ?? {}), ...Object.keys(pkg.publishConfig?.exports ?? {})].filter(
        (key) => (key === './register' || key.endsWith('/register')) && allowedKeys?.has(key) !== true,
      );
      const sideEffects =
        Array.isArray(pkg.sideEffects) && pkg.sideEffects.some((entry) => String(entry).includes('namespace'));

      return exportKeys.length > 0 || sideEffects ? [relPath] : [];
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
    const source = stripComments(readFileSync(join(frameworkRoot, file), 'utf8'));
    if (/MakaioBus\.registerNamespace\s*\(/.test(source) || /createStorageNamespace\s*\(/.test(source)) {
      sideEffectfulFactories.add(factoryName);
    }
  }

  return sideEffectfulFactories;
}

function listPackageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && packageSkipDirs.has(entry.name)) return [];

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return listPackageFiles(fullPath);
    return entry.name === 'package.json' ? [fullPath] : [];
  });
}
