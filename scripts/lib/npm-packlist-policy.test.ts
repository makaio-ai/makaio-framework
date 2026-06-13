import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkDeclarationDependencies,
  checkDescriptorEntrypointFiles,
  checkManifestExportTargets,
  checkPacklist,
  checkRuntimeWorkspaceDependencies,
  checkSourceManifestMakaioReferences,
  extractBareImportSpecifiers,
  type PackedExtensionDescriptor,
  type PackedPackageManifest,
} from './npm-packlist-policy.js';
import { NPM_PUBLISH_DIRECTORY } from './npm-publish-staging.js';

const FRAMEWORK_ROOT = resolve(import.meta.dirname, '..', '..');

function readPackageJson(packageDir: string): PackedPackageManifest {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as PackedPackageManifest;
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function discoverPublicPackageManifests(root: string): Array<{ path: string; manifest: PackedPackageManifest }> {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((packageDir) => existsSync(join(packageDir, 'package.json')))
    .map((packageDir) => ({ path: join(packageDir, 'package.json'), manifest: readPackageJson(packageDir) }))
    .filter(({ manifest }) => {
      return (manifest.publishConfig as { access?: unknown } | undefined)?.access === 'public';
    });
}

describe('npm packlist policy', () => {
  it('accepts dist files plus package metadata', () => {
    const result = checkPacklist('@makaio/adapter-openai-node', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.d.ts',
      'descriptor.json',
    ]);
    expect(result.missingRequired).toEqual([]);
    expect(result.forbidden).toEqual([]);
  });

  it('rejects sourcemaps and source directories', () => {
    const result = checkPacklist('@makaio/adapter-openai-node', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.js',
      'dist/index.js.map',
      'src/index.ts',
    ]);
    expect(result.forbidden).toContain('dist/index.js.map');
    expect(result.forbidden).toContain('src/index.ts');
  });

  it('rejects tests, fixtures, build config, lockfiles, env files, and logs', () => {
    const result = checkPacklist('@makaio/test', [
      'package.json',
      'README.md',
      'LICENSE',
      '__tests__/foo.test.ts',
      'fixtures/data.json',
      'build.ts',
      'vite.config.ts',
      'tsconfig.json',
      'yarn.lock',
      '.env.local',
      'npm-debug.log',
    ]);
    expect(result.forbidden).toContain('__tests__/foo.test.ts');
    expect(result.forbidden).toContain('fixtures/data.json');
    expect(result.forbidden).toContain('build.ts');
    expect(result.forbidden).toContain('vite.config.ts');
    expect(result.forbidden).toContain('tsconfig.json');
    expect(result.forbidden).toContain('yarn.lock');
    expect(result.forbidden).toContain('.env.local');
    expect(result.forbidden).toContain('npm-debug.log');
  });

  it('rejects Drizzle generator snapshots from published migration chains', () => {
    const result = checkPacklist('@makaio/storage-pg', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.mjs',
      'drizzle-postgres/0000_init.sql',
      'drizzle-postgres/meta/_journal.json',
      'drizzle-postgres/meta/0000_snapshot.json',
      'drizzle/meta/0001_snapshot.json',
    ]);

    expect(result.forbidden).toEqual(['drizzle-postgres/meta/0000_snapshot.json', 'drizzle/meta/0001_snapshot.json']);
    expect(result.forbidden).not.toContain('drizzle-postgres/meta/_journal.json');
  });

  it('rejects every source-only file from published runtime migration chains', () => {
    const result = checkPacklist('@makaio/storage-pg', [
      'package.json',
      'README.md',
      'LICENSE',
      'dist/index.mjs',
      'drizzle-postgres/0000_init.sql',
      'drizzle-postgres/meta/_journal.json',
      'drizzle-postgres/0001_messages_content_tsv.na.md',
      'drizzle-postgres/README.md',
      'dist/drizzle/0000_init.sql',
      'dist/drizzle/meta/_journal.json',
      'dist/drizzle/notes/schema.md',
    ]);

    expect(result.forbidden).toEqual([
      'drizzle-postgres/0001_messages_content_tsv.na.md',
      'drizzle-postgres/README.md',
      'dist/drizzle/notes/schema.md',
    ]);
  });

  it('reports missing README and LICENSE', () => {
    const result = checkPacklist('@makaio/test', ['package.json', 'dist/index.js']);
    expect(result.missingRequired).toContain('README.md');
    expect(result.missingRequired).toContain('LICENSE');
  });

  it('checks the packed manifest exports instead of publishConfig exports', () => {
    const issues = checkManifestExportTargets(
      {
        name: '@makaio/extension-test',
        exports: {
          '.': './src/index.ts',
          './package.json': './package.json',
        },
        publishConfig: {
          exports: {
            '.': './dist/index.mjs',
            './package.json': './package.json',
          },
        },
      },
      ['package.json', 'README.md', 'LICENSE', 'dist/index.mjs'],
    );

    expect(issues).toEqual(['@makaio/extension-test: manifest entrypoint missing from packlist: src/index.ts']);
  });

  it('checks packed manifest main and types targets', () => {
    const issues = checkManifestExportTargets(
      {
        name: '@makaio/extension-test',
        main: 'dist/index.mjs',
        types: 'dist/index.d.mts',
      },
      ['package.json', 'README.md', 'LICENSE', 'dist/index.mjs'],
    );

    expect(issues).toEqual(['@makaio/extension-test: manifest entrypoint missing from packlist: dist/index.d.mts']);
  });

  it('rejects workspace protocol in all dependency fields of staged manifests', () => {
    const issues = checkRuntimeWorkspaceDependencies(
      {
        name: '@makaio/extension-test',
        dependencies: {
          '@makaio/kernel': 'workspace:*',
        },
        devDependencies: {
          '@makaio/build-tooling': 'workspace:*',
        },
      },
      { includeDevDependencies: true },
    );

    expect(issues).toEqual([
      '@makaio/extension-test: runtime dependency uses workspace protocol: dependencies.@makaio/kernel',
      '@makaio/extension-test: staged manifest contains workspace protocol: devDependencies.@makaio/build-tooling',
    ]);
  });

  it('ignores workspace devDependencies of source manifests packed in place', () => {
    const issues = checkRuntimeWorkspaceDependencies({
      name: '@makaio/provider-test',
      devDependencies: {
        '@makaio/build-tooling': 'workspace:*',
      },
    });

    expect(issues).toEqual([]);
  });

  it('accepts staged manifests with no workspace protocol in any dependency field', () => {
    const issues = checkRuntimeWorkspaceDependencies(
      {
        name: '@makaio/extension-test',
        dependencies: { zod: '^4.0.0' },
        devDependencies: { vitest: '4.1.7' },
        peerDependencies: { '@makaio/framework': '^1.0.0' },
      },
      { includeDevDependencies: true },
    );

    expect(issues).toEqual([]);
  });

  it('rejects @makaio packages in the runtime dependencies of unstaged manifests', () => {
    const issues = checkSourceManifestMakaioReferences({
      name: '@makaio/storage-pg',
      dependencies: {
        '@makaio/storage-drizzle': 'workspace:*',
        pg: '^8.21.0',
      },
      devDependencies: {
        '@makaio/build-tooling': 'workspace:*',
      },
      peerDependencies: {
        '@makaio/framework': '^1.0.0',
      },
    });

    expect(issues).toEqual([
      '@makaio/storage-pg: unpublishable @makaio package in dependencies: @makaio/storage-drizzle (bundled workspace packages belong in devDependencies; runtime framework coupling goes through the @makaio/framework peer dependency)',
    ]);
  });

  it('accepts dev-only @makaio references plus the framework peer, rejects other @makaio peers', () => {
    expect(
      checkSourceManifestMakaioReferences({
        name: '@makaio/storage-pg',
        dependencies: { pg: '^8.21.0' },
        devDependencies: { '@makaio/storage-drizzle': 'workspace:*' },
        peerDependencies: { '@makaio/framework': '^1.0.0' },
      }),
    ).toEqual([]);

    expect(
      checkSourceManifestMakaioReferences({
        name: '@makaio/storage-pg',
        peerDependencies: { '@makaio/storage-drizzle': '^1.0.0' },
      }),
    ).toEqual(['@makaio/storage-pg: @makaio peer dependency other than @makaio/framework: @makaio/storage-drizzle']);
  });

  it('keeps public adapter and client source manifests publishable without runtime @makaio workspace deps', () => {
    const packageManifests = [
      ...discoverPublicPackageManifests(join(FRAMEWORK_ROOT, 'adapters', 'implementations')),
      ...discoverPublicPackageManifests(join(FRAMEWORK_ROOT, 'clients')),
    ];

    const issues = packageManifests.flatMap(({ path, manifest }) =>
      checkSourceManifestMakaioReferences(manifest).map((issue) => `${path}: ${issue}`),
    );

    expect(issues).toEqual([]);
  });

  it('keeps public provider source manifests publishable without runtime @makaio workspace deps', () => {
    const packageManifests = discoverPublicPackageManifests(join(FRAMEWORK_ROOT, 'providers'));

    const issues = packageManifests.flatMap(({ path, manifest }) =>
      checkSourceManifestMakaioReferences(manifest).map((issue) => `${path}: ${issue}`),
    );

    expect(issues).toEqual([]);
  });

  it('keeps the public contracts source manifest publishable without runtime @makaio workspace deps', () => {
    const path = join(FRAMEWORK_ROOT, 'core', 'contracts', 'package.json');
    const manifest = readJsonFile<PackedPackageManifest>(path);
    const issues = checkSourceManifestMakaioReferences(manifest).map((issue) => `${path}: ${issue}`);

    expect(issues).toEqual([]);
    expect(manifest.peerDependencies?.['@makaio/framework']).toBe('^1.0.0');
  });

  it('keeps every public adapter package loadable through the convention server entry', () => {
    const adapterManifests = discoverPublicPackageManifests(join(FRAMEWORK_ROOT, 'adapters', 'implementations'));

    const issues = adapterManifests.flatMap(({ path, manifest }) => {
      const packageDir = path.slice(0, -'/package.json'.length);
      const descriptor = readJsonFile<PackedExtensionDescriptor>(join(packageDir, 'descriptor.json'));
      if (descriptor.entrypoints?.server !== true) {
        return [`${path}: public adapters must declare descriptor.entrypoints.server=true`];
      }

      return checkDescriptorEntrypointFiles(
        manifest.name ?? path,
        descriptor,
        ['package.json', 'README.md', 'LICENSE', 'descriptor.json', 'dist/index.mjs', 'dist/server.mjs'],
        manifest,
      ).map((issue) => `${path}: ${issue}`);
    });

    expect(issues).toEqual([]);
  });

  it('stages public client packages before npm packlist validation', () => {
    const clientManifests = discoverPublicPackageManifests(join(FRAMEWORK_ROOT, 'clients'));

    const issues = clientManifests.flatMap(({ path, manifest }) => {
      const directory = (manifest.publishConfig as { directory?: unknown } | undefined)?.directory;
      return directory === NPM_PUBLISH_DIRECTORY
        ? []
        : [`${path}: public clients must publish from ${NPM_PUBLISH_DIRECTORY}`];
    });

    expect(issues).toEqual([]);
  });

  it('requires descriptor entrypoint stems to exist as dist files in the packlist', () => {
    const issues = checkDescriptorEntrypointFiles(
      '@makaio/extension-client-hooks',
      {
        entrypoints: {
          cli: 'cli/index',
        },
      },
      ['package.json', 'README.md', 'LICENSE', 'descriptor.json', 'dist/cli.mjs'],
    );

    expect(issues).toEqual([
      '@makaio/extension-client-hooks: descriptor entrypoint missing from packlist: dist/cli/index.mjs',
    ]);
  });

  it('rejects boolean true entrypoint when dist file is missing from packlist', () => {
    const issues = checkDescriptorEntrypointFiles(
      '@makaio/adapter-openai-node',
      { entrypoints: { server: true } },
      ['package.json', 'README.md', 'LICENSE', 'descriptor.json', 'dist/index.mjs'],
      {
        name: '@makaio/adapter-openai-node',
        exports: {
          '.': { types: './dist/index.d.mts', default: './dist/index.mjs' },
          './server': { types: './dist/server.d.mts', default: './dist/server.mjs' },
          './package.json': './package.json',
        },
      },
    );

    expect(issues).toEqual([
      '@makaio/adapter-openai-node: descriptor entrypoint missing from packlist: dist/server.mjs',
    ]);
  });

  it('rejects boolean true entrypoint when subpath export is missing from published exports', () => {
    const issues = checkDescriptorEntrypointFiles(
      '@makaio/adapter-openai-node',
      { entrypoints: { server: true } },
      ['package.json', 'README.md', 'LICENSE', 'descriptor.json', 'dist/index.mjs', 'dist/server.mjs'],
      {
        name: '@makaio/adapter-openai-node',
        exports: {
          '.': { types: './dist/index.d.mts', default: './dist/index.mjs' },
          './package.json': './package.json',
        },
        publishConfig: {
          exports: {
            '.': { types: './dist/index.d.mts', default: './dist/index.mjs' },
            './package.json': './package.json',
          },
        },
      },
    );

    expect(issues).toEqual(['@makaio/adapter-openai-node: descriptor entrypoint missing subpath export: ./server']);
  });

  it('accepts boolean true entrypoint when dist file and subpath export are both present', () => {
    const issues = checkDescriptorEntrypointFiles(
      '@makaio/adapter-openai-node',
      { entrypoints: { server: true } },
      ['package.json', 'README.md', 'LICENSE', 'descriptor.json', 'dist/index.mjs', 'dist/server.mjs'],
      {
        name: '@makaio/adapter-openai-node',
        publishConfig: {
          exports: {
            '.': { types: './dist/index.d.mts', default: './dist/index.mjs' },
            './server': { types: './dist/server.d.mts', default: './dist/server.mjs' },
            './package.json': './package.json',
          },
        },
      },
    );

    expect(issues).toEqual([]);
  });

  it('skips subpath export check for boolean true entrypoint when no manifest is provided', () => {
    const issues = checkDescriptorEntrypointFiles('@makaio/adapter-openai-node', { entrypoints: { server: true } }, [
      'package.json',
      'README.md',
      'LICENSE',
      'descriptor.json',
      'dist/index.mjs',
      'dist/server.mjs',
    ]);

    expect(issues).toEqual([]);
  });
});

describe('extractBareImportSpecifiers', () => {
  it('extracts specifiers from static named imports', () => {
    const source = `import { Paths, Simplify } from "type-fest";`;
    expect(extractBareImportSpecifiers(source)).toContain('type-fest');
  });

  it('extracts specifiers from static namespace imports', () => {
    const source = `import * as zCore from "zod/v4/core";`;
    expect(extractBareImportSpecifiers(source)).toContain('zod');
  });

  it('extracts specifiers from export-from re-exports', () => {
    const source = `export { ZodType } from "zod";`;
    expect(extractBareImportSpecifiers(source)).toContain('zod');
  });

  it('extracts specifiers from side-effect imports', () => {
    const source = `import "reflect-metadata";`;
    expect(extractBareImportSpecifiers(source)).toContain('reflect-metadata');
  });

  it('extracts specifiers from dynamic import() type expressions', () => {
    // As produced by tsc/tsdown for namespace export declarations
    const source = `export declare const Foo: import("zod").ZodType;`;
    expect(extractBareImportSpecifiers(source)).toContain('zod');
  });

  it('extracts specifiers from triple-slash reference type directives', () => {
    const source = `/// <reference types="vite/client" />`;
    expect(extractBareImportSpecifiers(source)).toContain('vite');
  });

  it('maps subpath imports to their package root (unscoped)', () => {
    const source = `import * as core from "zod/v4/core";`;
    const specifiers = extractBareImportSpecifiers(source);
    expect(specifiers).toContain('zod');
    expect(specifiers).not.toContain('zod/v4/core');
  });

  it('maps subpath imports to their package root (scoped)', () => {
    const source = `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`;
    const specifiers = extractBareImportSpecifiers(source);
    expect(specifiers).toContain('@modelcontextprotocol/sdk');
    expect(specifiers).not.toContain('@modelcontextprotocol/sdk/server/stdio.js');
  });

  it('ignores relative imports', () => {
    const source = `import { Foo } from "./foo.js";\nimport { Bar } from "../bar.js";`;
    expect(extractBareImportSpecifiers(source)).toEqual([]);
  });

  it('ignores absolute imports', () => {
    const source = `import { Foo } from "/usr/local/lib/foo.js";`;
    expect(extractBareImportSpecifiers(source)).toEqual([]);
  });

  it('ignores node: prefixed imports', () => {
    const source = `import { readFileSync } from "node:fs";`;
    expect(extractBareImportSpecifiers(source)).toEqual([]);
  });

  it('ignores bare Node.js built-in names without node: prefix', () => {
    const source = `import { readFileSync } from "fs";\nimport { join } from "path";`;
    expect(extractBareImportSpecifiers(source)).toEqual([]);
  });

  it('deduplicates the same specifier appearing in multiple imports', () => {
    const source = [
      `import { ZodType } from "zod";`,
      `import { z } from "zod";`,
      `export { ZodObject } from "zod";`,
    ].join('\n');
    const specifiers = extractBareImportSpecifiers(source);
    expect(specifiers.filter((s) => s === 'zod')).toHaveLength(1);
  });

  it('handles a realistic declaration rollup with multiple import forms', () => {
    const source = [
      `import { ZodType, z } from "zod";`,
      `import { Paths, Simplify, UnknownRecord } from "type-fest";`,
      `import * as zCore from "zod/v4/core";`,
      `export declare const BusNamespace: import("@makaio/framework/bus").IBusNamespace;`,
      `/// <reference types="vite/client" />`,
      `import { readFileSync } from "node:fs";`,
      `import { join } from "path";`,
      `import { relative } from "./utils.js";`,
    ].join('\n');
    const specifiers = extractBareImportSpecifiers(source);
    expect(specifiers).toContain('zod');
    expect(specifiers).toContain('type-fest');
    expect(specifiers).toContain('@makaio/framework');
    expect(specifiers).toContain('vite');
    expect(specifiers).not.toContain('node:fs');
    expect(specifiers).not.toContain('path');
    expect(specifiers).not.toContain('./utils.js');
  });
});

describe('checkDeclarationDependencies', () => {
  it('reports undeclared bare imports as issues', () => {
    const issues = checkDeclarationDependencies(
      { name: '@makaio/core', dependencies: { zod: '^4.0.0' } },
      { 'dist/index.d.mts': ['zod', 'type-fest'] },
    );
    expect(issues).toEqual(['@makaio/core: declaration file dist/index.d.mts imports undeclared package: type-fest']);
  });

  it('accepts imports declared in dependencies', () => {
    const issues = checkDeclarationDependencies(
      { name: '@makaio/core', dependencies: { zod: '^4.0.0', 'type-fest': '^5.0.0' } },
      { 'dist/index.d.mts': ['zod', 'type-fest'] },
    );
    expect(issues).toEqual([]);
  });

  it('accepts imports declared in peerDependencies', () => {
    const issues = checkDeclarationDependencies(
      { name: '@makaio/core', peerDependencies: { react: '^18.0.0' } },
      { 'dist/index.d.mts': ['react'] },
    );
    expect(issues).toEqual([]);
  });

  it('rejects imports present only in devDependencies', () => {
    const issues = checkDeclarationDependencies(
      {
        name: '@makaio/core',
        devDependencies: { 'type-fest': '^5.0.0' },
      },
      { 'dist/index.d.mts': ['type-fest'] },
    );
    expect(issues).toEqual(['@makaio/core: declaration file dist/index.d.mts imports undeclared package: type-fest']);
  });

  it('accepts self-imports matching the package name', () => {
    const issues = checkDeclarationDependencies(
      { name: '@makaio/framework' },
      { 'dist/index.d.mts': ['@makaio/framework'] },
    );
    expect(issues).toEqual([]);
  });

  it('accepts self-imports with a subpath of the package name', () => {
    const issues = checkDeclarationDependencies(
      { name: '@makaio/framework' },
      { 'dist/core/index.d.mts': ['@makaio/framework'] },
    );
    expect(issues).toEqual([]);
  });

  it('reports issues for each file that has an undeclared import', () => {
    const issues = checkDeclarationDependencies(
      { name: '@makaio/framework', dependencies: { zod: '^4.0.0' } },
      {
        'dist/core/index.d.mts': ['zod', 'type-fest'],
        'dist/bus/index.d.mts': ['zod', 'emittery'],
      },
    );
    expect(issues).toContain(
      '@makaio/framework: declaration file dist/core/index.d.mts imports undeclared package: type-fest',
    );
    expect(issues).toContain(
      '@makaio/framework: declaration file dist/bus/index.d.mts imports undeclared package: emittery',
    );
    expect(issues).toHaveLength(2);
  });

  it('returns no issues when declarationImports is empty', () => {
    const issues = checkDeclarationDependencies({ name: '@makaio/core' }, {});
    expect(issues).toEqual([]);
  });
});
